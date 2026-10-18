---
title: Rate limit
description: Per-client request limits with sliding-window or token-bucket algorithms, standard RateLimit headers, and in-memory or Redis stores.
---

```bash
bun add @knead-js/core @knead-js/http @knead-js/rate-limit
```

`@knead-js/core` and `@knead-js/http` are peer dependencies, so every package shares one copy.
`RedisStore` uses Bun's built-in Redis client, so no Redis package is needed.

`@knead-js/rate-limit` counts requests per client and answers `429 Too Many Requests` once a
client goes over its budget. A global middleware applies one limit to every request; decorators
give individual routes their own limits or exempt them; a guard applies the same limits after
authentication, so you can limit per user. Counters live in memory for a single process, or in
Redis when several instances must share them. For how it fits with CORS and security headers,
see [security](/guide/security/).

## `RateLimitModule`

`RateLimitModule.forRoot(options: RateLimitModuleOptions): DynamicModule` validates the options
with `validateRateLimitOptions()` and returns a global module. It provides `RATE_LIMIT_OPTIONS`,
`RATE_LIMIT_STORE` (your `store`, or a new `MemoryStore`), `RateLimiter`, `RateLimitMiddleware`
and `RateLimitGuard`, exports all but the middleware, and registers `RateLimitMiddleware` as global
middleware with priority 900 unless `middleware` is `false`. The store's `close()` runs when the
application shuts down.

<<< security/rate-limit.ts#module title="app.module.ts"

### `RateLimitModuleOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | `number` | required | Requests allowed per `window`. A positive integer. |
| `window` | `Duration` | required | The window, such as `'1m'`. See [durations](#durations). |
| `algorithm` | `Algorithm` | `'sliding-window'` | `'sliding-window'` or `'token-bucket'`, for every limit of the module. See [algorithms](#algorithms). |
| `store` | `RateLimitStore` | a new `MemoryStore()` | Where counters live. |
| `key` | `KeyFn` | the client IP | Which client a request belongs to. See [keys](#keys). |
| `ipv6Subnet` | `number` | `64` | Prefix length the default key masks IPv6 addresses to. An integer from 1 to 128; 128 keys each address. |
| `onMissingKey` | `'skip'`, `'shared'` or `'deny'` | `'shared'` | What to do when the key function returns no key. See [keys](#keys). |
| `onStoreError` | `'allow'` or `'deny'` | `'allow'` | What to do when the store throws. See [store failures](#store-failures). |
| `middleware` | `boolean` | `true` | Install the global `RateLimitMiddleware`. Set `false` to count only through `RateLimitGuard`. |

`validateRateLimitOptions(options: RateLimitModuleOptions): void` throws a `RangeError` for a
`limit` that is not a positive integer, an invalid or out-of-range `window`, an `ipv6Subnet`
outside 1 to 128 (`0` would put every IPv6 client in one bucket), an unknown
`onMissingKey`, `onStoreError` or `algorithm`, a `store` without a `consume()` method, a `key`
that is not a function and a `middleware` that is not a boolean. An unknown `onStoreError` is
rejected rather than treated as `'allow'`, and a malformed `store` rather than failing on every
request, so a mistake cannot silently make the limit fail open.

## Counters

Each request is counted against one counter, identified by a scope and the client key:

- Routes without `@RateLimit()`, unmatched requests (404 and 405) and WebSocket upgrades share
  one global counter per client. (An upgrade on the path of a GET route counts like that route.) A client with a `limit` of 100 gets 100 requests per window
  across all of them.
- Each route with `@RateLimit()` has its own counter per client, named after its method and path.
- `RateLimitGuard` keeps counters separate from the middleware's, so a request passing through
  both counts once in each.

> [!WARNING]
> Because a `@RateLimit()` counter is per method and path, a handler reachable through several
> routes (several route decorators, `@All()`, or one controller mounted under two prefixes) gets one
> budget per route, multiplying the effective limit. Put the limit on a single route, or lower it
> accordingly.

CORS preflights do not count when `CorsModule` is installed: it answers them at priority 1000,
before rate limiting runs.

## Decorators

<<< security/rate-limit.ts#routes title="account.controller.ts"

### `@RateLimit()`

`RateLimit(options: RateLimitRouteOptions)` gives a route (method decorator) or every route of a
controller (class decorator) its own counter. `RateLimitRouteOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | `number` | the module's `limit` | A positive integer. |
| `window` | `Duration` | the module's `window` | Parsed with `parseDuration()`. |
| `key` | `KeyFn` | the module's `key` | The key function for this route. |

The options are validated when the decorator is applied: a `limit` that is not a positive
integer, an invalid `window` or a `key` that is not a function throws a `RangeError` at import
time. The decorator stores `RateLimitRouteMeta` (the options plus `windowMs`, the parsed window in
milliseconds) in route metadata under `RATE_LIMIT_META`.

A method decorator replaces a controller decorator rather than merging with it: options the method
leaves out come from the module, not from the controller.

### `@SkipRateLimit()`

`SkipRateLimit()` exempts a route or controller from the middleware and the guard: the request is
not counted and gets no `RateLimit-*` headers. It stores `true` under `SKIP_RATE_LIMIT_META`. Use
it for health checks that a load balancer polls.

## Keys

`KeyFn` is `(ctx: Ctx) => string | undefined | Promise<string | undefined>`. The default key is
`ctx.ip`, with IPv6 addresses masked to `ipv6Subnet` bits by `maskIp()`: one client usually
controls a whole /64 and could otherwise rotate addresses to reset its budget. IPv4-mapped IPv6
addresses are keyed as IPv4.

> [!IMPORTANT]
> Behind a reverse proxy or load balancer, set `listen({ trustProxy })` so `ctx.ip` comes from
> `X-Forwarded-For`. Otherwise every client has the proxy's address and shares one budget. Trust
> exactly the proxies you run: with more hops than you have, clients can choose their own key. See
> [server](/guide/server/).

When the key function returns `undefined` or an empty string (for example `ctx.ip` on a Unix
socket, or a header that is missing), `onMissingKey` decides:

| Value | Behavior |
| --- | --- |
| `'shared'` | The request counts against one anonymous counter per scope, shared by every keyless request. |
| `'skip'` | The request is not limited. |
| `'deny'` | The request is rejected with `403 Forbidden` (detail `Rate limiting requires a client key`). |

The first keyless request logs a warning.

The middleware runs before guards, so its key function sees the raw request but nothing a guard
set, such as `ctx.state.user`. To limit per user, either verify the credential inside the key
function, or count in the guard phase with `RateLimitGuard`.

### `RateLimitGuard`

`RateLimitGuard` applies the same module options and `@RateLimit()` overrides as a guard. Guards
run in order, so placed after your authentication guard its key function can read what that guard
stored. It always returns `true` when the request is within its limit, and sets the `RateLimit-*`
headers on the handler's response through `ctx.res.headers`.

<<< security/rate-limit-guard.ts#guard title="usage.module.ts"

Use it with `@UseGuards(AuthGuard, RateLimitGuard)` or as an `APP_GUARD`. With `middleware: false`
only the guard counts.

`RateLimitGuard` also works on GraphQL resolvers (`@UseGuards(RateLimitGuard)` on a resolver
class or method): it reads the request from `ctx.http` (the default key is `ctx.http.ip`), keeps one
counter per resolver field that has `@RateLimit()`, puts the headers on the GraphQL HTTP response,
and a denial is a `RATE_LIMITED` GraphQL error. See [GraphQL](/guide/graphql/).

A guarded field without `@RateLimit()` counts against the guard's global budget once per HTTP
request: a nested field in a list resolves once per item, but all its checks, and a `RateLimitGuard`
on the GraphQL route itself, share one store call. A field with `@RateLimit()` counts every time it
resolves, so its limit bounds how often that field runs.

## Responses

Every counted request that is allowed gets:

| Header | Value |
| --- | --- |
| `RateLimit-Limit` | The limit that applied. |
| `RateLimit-Remaining` | Requests left. |
| `RateLimit-Reset` | Seconds, rounded up, until the quota is fully restored: the end of the current window (sliding window) or until the bucket is full (token bucket). |

A request over the limit is rejected with a `TooManyRequestsException`, rendered as an RFC 9457
problem response with `Content-Type: application/problem+json; charset=utf-8`, the same three
headers and `Retry-After`. On a denial, `RateLimit-Remaining` is `0`, and both `RateLimit-Reset`
and `Retry-After` give the seconds, rounded up, until the earliest moment a request would be
admitted (`Retry-After` is at least 1):

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
CORS exposes them: list `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and
`Retry-After` in `exposedHeaders` (see [CORS](/packages/cors/)).

### Store failures

When the store throws (Redis is down, or slower than `commandTimeout`), the failure is logged as a
warning with a correlation id, and `onStoreError` decides what happens to the request. An outage
fails every request, so the logging is throttled: the first failure is logged, then at most one
line every 10 seconds (`Rate limit store still failing (N failures not logged)`), and the first
success afterwards logs `Rate limit store recovered after N failures.`


| Value | Behavior |
| --- | --- |
| `'allow'` | Fail open: the request goes through, without `RateLimit-*` headers. |
| `'deny'` | Fail closed: `503 Service Unavailable`. Outside development the response carries no detail, like every 5xx. |

Use `'deny'` when the limit protects authentication (login, password reset, one-time codes):
failing open would let an attacker brute-force while Redis is unavailable.

## Algorithms

`Algorithm` is `'sliding-window' | 'token-bucket'`.

| Algorithm | Behavior |
| --- | --- |
| `'sliding-window'` | Counts requests in fixed windows of `window` length and weighs the previous window by how much of it still overlaps the sliding window ending now. A request is allowed while `previous × overlap + current + 1 ≤ limit`. It smooths the burst at window boundaries that a plain fixed window allows. |
| `'token-bucket'` | A bucket of `limit` tokens, refilled continuously at `limit` tokens per `window`, starting full. Each request takes one token. Allows bursts up to `limit`, then a steady rate. |

Both stores implement both algorithms with the same arithmetic. A store is told the rule on each
call (`RateLimitRule`: `{ limit, windowMs, algorithm }`), so routes with different limits share a
store.

## Durations

`Duration` is `` number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}` ``: a number of milliseconds,
or a string such as `'500ms'`, `'15s'`, `'1.5m'`, `'1h'` or `'1d'`.

`parseDuration(value: Duration | string): number` returns whole milliseconds, rounded up and at
least 1. It throws a `RangeError` for anything else (`'1w'`, `'1 m'`, `null`, `undefined`, an
object), for zero, negative or
non-finite values, and for more than `MAX_DURATION_MS`, 31536000000 (365 days).

## Stores

### `MemoryStore`

The default store. Counters live in the process, so every process (or Bun worker) has its own: with
four instances behind a load balancer, a client effectively gets four times the limit. Use
`RedisStore` for more than one process.

`new MemoryStore(options?: MemoryStoreOptions)`. `MemoryStoreOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxKeys` | `number` | `10000` | Most counters kept (an integer of at least 1). The least recently used are evicted, which resets them. A flood of distinct keys can therefore reset other clients' counters: size it for your key cardinality, or use `RedisStore`. |
| `sweepIntervalMs` | `number` | `60000` | How often expired counters are removed. `0` disables the timer. A negative, `NaN` or infinite value is a `RangeError`. The timer does not keep the process alive. |
| `hashKeys` | `boolean` | `true` | Store keys as HMAC-SHA256 hashes (32 hex characters) under a random per-process secret, so client IPs and API keys cannot be read from a memory dump and long keys cost a fixed size. |
| `now` | `() => number` | `Date.now` | The clock, for tests. |

It also has `size` (the number of counters), `sweep()` and `close()` (stops the timer).

### `RedisStore`

Counters shared by every instance through Redis or Valkey. Each `consume()` is one Lua script
(`EVALSHA`, falling back to `EVAL` when the script is not cached), so checks are atomic, and the
script uses the Redis server's `TIME` as its clock, so whether a request is admitted does not
depend on instance clocks. The `RateLimit-Reset` and `Retry-After` headers are computed from the
store's `resetAt` against the instance clock, so a skewed instance reports them off by its skew.

<<< security/redis-store.ts#store title="rate-limit.module.ts"

`new RedisStore(options?: RedisStoreOptions)`. `RedisStoreOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | Bun's default (`REDIS_URL`, `VALKEY_URL`, then localhost) | Connection URL, used when no `client` is given. |
| `client` | `RedisClient` | none | An existing Bun `RedisClient`. It is not closed by `close()`, and it skips the plaintext check: configure TLS on it yourself. Give it `enableOfflineQueue: false` and a `connectionTimeout` so commands fail fast while Redis is unreachable. |
| `prefix` | `string` | `'knead:rl:'` | Prefix of every key. |
| `hashKeys` | `boolean` | `true` | Store hashes (32 hex characters) instead of raw keys. |
| `hashSecret` | `string` or `Uint8Array` | none | Key for the hashes (HMAC-SHA256), at least 32 bytes and the same on every instance. Without it, the hash is plain SHA-256, and (with `hashKeys` on) a warning is logged once per process. |
| `requireTls` | `boolean` | `false` | Throw an `HttpConfigError` at construction instead of only warning when the URL is plaintext to a remote host. |
| `commandTimeout` | `number` | `250` | Milliseconds to wait for Redis before the call fails as a store error. An integer of at least 1. |
| `logger` | `Logger` | the application's `LOGGER` | Where the warnings go. Without it, the construction warnings are held until `RateLimitModule` starts and passes its `LOGGER` (`setLogger()`); a store used without the module sends them to a `ConsoleLogger('knead:rate-limit')` at its first `consume()`. |

When it builds its own client (no `client` option), the store creates it with
`enableOfflineQueue: false` and a `connectionTimeout` of `max(commandTimeout, 1000)` ms, and
connects before sending. While Redis is unreachable, each `consume()` fails within
`commandTimeout` as a store error instead of queueing a script that would be replayed, and
consume counters, once Redis is back.

Rules that protect the data in Redis:

- **Plaintext connections.** A `redis://` or `valkey://` URL (from `url`, `REDIS_URL` or
  `VALKEY_URL`) to a host that is not loopback sends keys and credentials unencrypted. The
  constructor logs a warning, or throws an `HttpConfigError` with `requireTls: true`. `rediss://`
  and `valkeys://` URLs, Unix sockets and loopback hosts pass.
- **Hashed keys.** Keys are hashed by default. A plain SHA-256 of an IP address does not hide
  it, since every IPv4 address can be hashed in seconds, so set `hashSecret` (for example from
  `openssl rand -base64 32`). A shorter secret is a `RangeError`.
- **Least privilege.** Connect as an ACL user limited to the store's keys and the commands it
  runs, for example
  `ACL SETUSER ratelimit on >password resetkeys ~knead:rl:* -@all +evalsha +eval +get +incr +pexpire +hmget +hset +time`.

Keys include the window length, so changing a rule's window starts from fresh counters. The
sliding-window script derives its keys inside Lua, so `RedisStore` does not support Redis
Cluster.

### Custom stores

A store implements `RateLimitStore`:

| Member | Signature | Description |
| --- | --- | --- |
| `consume` | `(key: string, rule: RateLimitRule) => Promise<ConsumeResult>` | Counts one request atomically and reports the outcome. |
| `close` | `() => void` or `() => Promise<void>`, optional | Called when the application shuts down. |
| `setLogger` | `(logger: Logger) => void`, optional | Called once when `RateLimiter` is created, with the application's `LOGGER`, for a store built outside dependency injection. |

`ConsumeResult` is `{ allowed: boolean; remaining: number; resetAt: number }`. `resetAt` is in
epoch milliseconds: on a denial, the earliest time a request would be admitted (it becomes
`Retry-After`); when allowed, the time the quota is fully restored (it becomes `RateLimit-Reset`).

## Functions

### `maskIp()`

`maskIp(ip: string, prefix: number): string`, re-exported from `@knead-js/http`, returns the key
for a client address: IPv4 (including IPv4-mapped IPv6) as is, IPv6 masked to `prefix` bits and
written as `network/prefix` (`2001:db8:1:2::/64`). Unparseable input is returned unchanged. It
throws a `RangeError` unless `prefix` is an integer from 0 to 128.

### `hashKey()`

`hashKey(key: string, secret?: string | Uint8Array): string` returns the first 32 hex characters
(128 bits) of HMAC-SHA256 under `secret`, or of a plain SHA-256 without one (both computed with
`Bun.CryptoHasher`). Use it in a custom store.

## Classes and tokens

### `RateLimiter`

The check shared by the middleware and the guard. `check(ctx: Ctx, phase: 'middleware' | 'guard')`
returns the `RateLimit-*` headers to send, `undefined` when the request is not limited (skipped,
or allowed after a store failure), or throws the 429, 403 or 503 described above. It closes the
store on module destroy.

### `RateLimitMiddleware`

The global middleware (priority 900). It calls `RateLimiter.check()` and adds the headers to the
response.

### `RATE_LIMIT_OPTIONS` and `RATE_LIMIT_STORE`

`InjectionToken<RateLimitModuleOptions>` and `InjectionToken<RateLimitStore>`. Inject
`RATE_LIMIT_STORE` to inspect or reuse the configured store.

### `RATE_LIMIT_META` and `SKIP_RATE_LIMIT_META`

The route metadata keys (`Symbol('knead:rate-limit')` and `Symbol('knead:skip-rate-limit')`)
written by `@RateLimit()` and `@SkipRateLimit()`.
