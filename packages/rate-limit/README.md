# @knead-js/rate-limit

[![npm](https://img.shields.io/npm/v/@knead-js/rate-limit?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/rate-limit)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Per-client request limits for [Knead](https://github.com/quinnjr/knead) applications, with
sliding-window or token-bucket algorithms, standard `RateLimit-*` headers, and in-memory or Redis
stores.

**[Documentation](https://quinnjr.github.io/knead/packages/rate-limit/)** · [Guide](https://quinnjr.github.io/knead/guide/security/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/http @knead-js/rate-limit
```

Requires Bun 1.4.3 or newer. `@knead-js/core` and `@knead-js/http` are peer dependencies, so every
package shares one copy. `RedisStore` uses Bun's built-in Redis client: no Redis package is needed.

## Quick start

```ts
import { Module } from '@knead-js/core';
import { Controller, type Ctx, Get, Post } from '@knead-js/http';
import { RateLimit, RateLimitModule, SkipRateLimit } from '@knead-js/rate-limit';

@Controller('/')
export class AccountController {
  // One counter for this route: 5 attempts per client IP every 15 minutes.
  @Post('/login')
  @RateLimit({ limit: 5, window: '15m' })
  login() {
    return { token: 'issued' };
  }

  // Keyed by API key instead of IP; requests without the header share one bucket.
  @Get('/reports')
  @RateLimit({
    limit: 1000,
    window: '1h',
    key: (ctx: Ctx) => ctx.req.headers.get('x-api-key') ?? undefined,
  })
  reports() {
    return [];
  }

  @Get('/health')
  @SkipRateLimit()
  health() {
    return { ok: true };
  }

  @Get('/profile')
  profile() {
    return { name: 'Ada' };
  }
}

@Module({
  imports: [RateLimitModule.forRoot({ limit: 100, window: '1m' })],
  controllers: [AccountController],
})
export class AppModule {}
```

Every client IP gets 100 requests a minute across the routes without a decorator, `/login` has
its own budget of 5 attempts per 15 minutes, `/reports` is limited per API key, and `/health` is
not counted. A request over the limit gets a `429 Too Many Requests` problem response with
`Retry-After`.

## Features

- **Global, per-route or per-user.** A global middleware, `@RateLimit()` and `@SkipRateLimit()`
  decorators, and a `RateLimitGuard` that runs after authentication.
- **Two algorithms.** `'sliding-window'` (the default) or `'token-bucket'`.
- **Standard headers.** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and
  `Retry-After` on denials.
- **Shared counters.** `RedisStore` keeps limits consistent across instances, with atomic Lua
  scripts and the server's clock.
- **Private keys.** Both stores hash client keys (HMAC-SHA256) before storing them.
- **IPv6-aware.** The default key masks IPv6 addresses to a /64, so rotating addresses does not
  reset a budget.
- **Validated at startup.** Invalid limits, windows and option values are a `RangeError`, never a
  silent fallback.
- **GraphQL too.** `RateLimitGuard` works on resolvers, where a denial is a `RATE_LIMITED` error.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `limit` | required | Requests allowed per `window`. A positive integer. |
| `window` | required | A duration such as `'500ms'`, `'15s'`, `'1m'`, `'1h'` or `'1d'`, at most 365 days. |
| `algorithm` | `'sliding-window'` | `'sliding-window'` or `'token-bucket'`. |
| `store` | a new `MemoryStore()` | Where counters live. |
| `key` | the client IP | A function of the request `Ctx` returning the client key (or a promise of it). |
| `ipv6Subnet` | `64` | Prefix length the default key masks IPv6 addresses to, from 1 to 128. |
| `onMissingKey` | `'shared'` | When the key is missing: `'shared'` (one anonymous counter), `'skip'` or `'deny'` (403). |
| `onStoreError` | `'allow'` | When the store throws: `'allow'` (fail open) or `'deny'` (503). |
| `middleware` | `true` | Install the global middleware. `false` counts only through `RateLimitGuard`. |

`RateLimitModule.forRoot()` rejects with a `RangeError` a `limit` that is not a positive integer,
an invalid or out-of-range `window`, an `ipv6Subnet` outside 1 to 128, and an unknown
`onMissingKey`, `onStoreError` or `algorithm`. A typo such as `onStoreError: 'Deny'` is therefore
an error at startup, not a limit that silently fails open. `@RateLimit()` validates its own
`limit` and `window` when it is applied.

## Counters and keys

- Routes without `@RateLimit()`, unmatched requests (404 and 405) and WebSocket upgrades share one
  global counter per client.
- Each `@RateLimit()` route has its own counter per client, named after its method and path. A
  handler reachable through several routes (`@All()`, several decorators, two mount prefixes) gets
  one budget per route, so put the limit on a single route.
- CORS preflights are not counted when `@knead-js/cors` is installed: it answers them first.
- Behind a reverse proxy or load balancer, set `listen({ trustProxy })` so `ctx.ip` comes from
  `X-Forwarded-For`. Otherwise every client shares the proxy's address and one budget. Trust
  exactly the proxies you run, or clients can choose their own key.

## Limiting per user

The global middleware runs before guards, so its key function cannot see what an authentication
guard stored. Count in the guard phase instead, with `RateLimitGuard` after your own guard:

```ts
/** Resolves the caller's account from its API key and stores it for later guards. */
export class ApiKeyGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    const account = apiKeys.get(ctx.req.headers.get('x-api-key') ?? '');
    if (account === undefined) return false;
    ctx.state.accountId = account;
    return true;
  }
}

@Controller('/usage')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class UsageController {
  @Get('/')
  usage() {
    return { calls: 42 };
  }
}

@Module({
  imports: [
    RateLimitModule.forRoot({
      limit: 1000,
      window: '1h',
      // Only the guard counts; the global middleware is not installed.
      middleware: false,
      // Runs after ApiKeyGuard, so the account is known.
      key: (ctx) => {
        const account = ctx.state.accountId;
        return typeof account === 'string' ? account : ctx.ip;
      },
    }),
  ],
  controllers: [UsageController],
})
export class AppModule {}
```

## Redis

`MemoryStore` keeps counters in the process, so with four instances behind a load balancer a
client gets four times the limit. Share them through Redis or Valkey:

```ts
import { RateLimitModule, RedisStore } from '@knead-js/rate-limit';

export function rateLimitModule(env: Record<string, string | undefined>) {
  return RateLimitModule.forRoot({
    limit: 100,
    window: '1m',
    algorithm: 'token-bucket',
    store: new RedisStore({
      url: env.RATE_LIMIT_REDIS_URL, // rediss://ratelimit:password@redis.internal:6380
      hashSecret: env.RATE_LIMIT_HASH_SECRET, // openssl rand -base64 32, same on every instance
      requireTls: true,
    }),
    // A Redis outage rejects requests with 503 instead of letting them through.
    onStoreError: 'deny',
  });
}
```

- **TLS.** A plaintext `redis://` or `valkey://` URL to a host that is not loopback logs a warning;
  with `requireTls: true` it throws an `HttpConfigError` instead. A `client` you pass in skips this
  check, so configure TLS on it yourself.
- **Keyed hashes.** Set `hashSecret` (at least 32 bytes, the same on every instance). Without it,
  keys are plain SHA-256 hashes, which do not hide IP addresses, and a warning is logged once.
- **Fail closed where it matters.** A Redis failure or a reply slower than `commandTimeout`
  (250 ms) is a store error. Use `onStoreError: 'deny'` for login, password reset and one-time
  codes, where failing open would allow brute force during an outage.
- **Least privilege.** Connect as an ACL user limited to the store's keys and commands:
  `ACL SETUSER ratelimit on >password resetkeys ~knead:rl:* -@all +evalsha +eval +get +incr +pexpire +hmget +hset +time`.
- `RedisStore` does not support Redis Cluster.

## Responses

```http
HTTP/1.1 429 Too Many Requests
content-type: application/problem+json; charset=utf-8
x-content-type-options: nosniff
ratelimit-limit: 5
ratelimit-remaining: 0
ratelimit-reset: 840
retry-after: 840

{"type":"about:blank","title":"Too Many Requests","status":429,"detail":"Rate limit exceeded","instance":"/login"}
```

Rejected requests do not consume quota. Browsers on other origins can read these headers only if
CORS lists `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After` in
`exposedHeaders`.

## Documentation

- [`@knead-js/rate-limit` reference](https://quinnjr.github.io/knead/packages/rate-limit/):
  algorithms, stores, custom stores and every export.
- [Security guide](https://quinnjr.github.io/knead/guide/security/): how rate limiting fits with
  CORS and security headers.
- [Server guide](https://quinnjr.github.io/knead/guide/server/): `trustProxy` and client IPs.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
