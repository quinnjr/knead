# @hpmws/rate-limit

`RateLimitModule.forRoot({ limit, window })` with sliding-window or token-bucket algorithms, `@RateLimit()` (validated at decoration time) / `@SkipRateLimit()`, standard `RateLimit-*` headers and `Retry-After` computed from the earliest admission time, and `MemoryStore` or `RedisStore` (atomic Lua on `Bun.redis`) for multi-instance deployments. Windows are integer milliseconds (durations are rounded up). `RedisStore` is not compatible with Redis Cluster.

In production, connect `RedisStore` with `rediss://` (TLS) as a least-privilege ACL user limited to the store's keys and the commands it runs, for example `ACL SETUSER ratelimit on >secret resetkeys ~hpmws:rl:* -@all +evalsha +eval +get +incr +pexpire +hmget +hset +time +script|load`. A plaintext `redis://` or `valkey://` URL (from `url`, `REDIS_URL` or `VALKEY_URL`) to a non-loopback host logs a warning at construction; `new RedisStore({ requireTls: true })` throws instead. A caller-supplied `client` bypasses this check, so configure TLS on it yourself.

Windows are capped at one year (`365d`); a longer one is a `RangeError` at decoration or `forRoot()` time.

The default key is the client IP (`ctx.ip`). IPv6 addresses are masked to a /64 (`ipv6Subnet`, an integer from 1 to 128, default 64; 0 is rejected because it would put every IPv6 client in one bucket; 128 keys each address; IPv4-mapped addresses are keyed as IPv4), because one client usually controls a whole /64 and could otherwise rotate addresses to reset its bucket. Both stores hash keys before storing them (32 hex characters; `hashKeys: false` keeps raw keys). `MemoryStore` uses HMAC-SHA256 under a random per-process secret, so client IPs and API keys cannot be read or recovered from a memory dump. `RedisStore` uses HMAC-SHA256 under `hashSecret` (at least 32 bytes, the same on every instance sharing the Redis server); without it, it falls back to plain SHA-256 and logs a one-time warning, because an unkeyed hash does not hide IPs (every IPv4 address can be hashed in seconds), so anyone who can read the Redis keys can recover the client IPs:

```ts
new RedisStore({ url: process.env.REDIS_URL, hashSecret: process.env.RATE_LIMIT_HASH_SECRET });
```

When the key function returns no key (for example `ctx.ip` on a Unix socket, or a custom key read from a missing header), `onMissingKey` decides: `'shared'` (default) counts the request against one anonymous bucket per scope, `'skip'` lets it through unlimited, and `'deny'` rejects it with 403. The first keyless request logs a warning.

Behind a reverse proxy or load balancer, configure `app.listen({ trustProxy })` (a hop count or a list of proxy CIDRs) so `ctx.ip` comes from `X-Forwarded-For`; otherwise every client shares the proxy's address and therefore one bucket. With a hop count, set it to exactly the number of proxies in front of the app: a request whose `X-Forwarded-For` has fewer entries than that is keyed by the socket peer (the proxy), not by a client-supplied value. Never trust more hops than you have, or clients can pick their own key. WebSocket upgrade requests count against the same per-IP bucket (CORS rejects disallowed origins before rate limiting runs).

Each `@RateLimit()` route has its own counter, keyed by its method and path. A handler reachable through several routes (several decorators, `@All()`, or the same controller mounted under two prefixes) therefore gets one budget per alias, multiplying the effective limit; put the limit on a single route, or lower it accordingly. `RedisStore` waits at most `commandTimeout` (default 250 ms) for Redis; a timeout is a store error like any other. Give a caller-supplied `client` `enableOfflineQueue: false` and a `connectionTimeout`, so commands fail fast while Redis is unreachable instead of queueing. `onStoreError` (default `'allow'`, fail open with a warning) decides what happens when the store throws: use `'deny'` (503) when the limit protects authentication (login, password reset, OTP checks), where failing open would let an attacker brute-force during a Redis outage.

Ordering: `RateLimitModule` installs a global middleware (priority 900), and middleware runs before guards, so its key function sees the raw request but nothing a guard set (such as `ctx.state.user`). A key that should follow the authenticated user either verifies the credential itself and falls back to the IP, or runs in the guard phase:

```ts
// Middleware phase: verify the credential in the key, fall back to the IP.
const key = (ctx: Ctx) => auth.verify(ctx.req.headers.get('authorization'))?.id ?? ctx.ip;

// Guard phase: RateLimitGuard runs after the guards before it, so it can key on ctx.state.
RateLimitModule.forRoot({ limit: 100, window: '1m', middleware: false, key: (ctx) => ctx.state.user?.id ?? ctx.ip });
@UseGuards(AuthGuard, RateLimitGuard) // or provide it as APP_GUARD
```

`RateLimitGuard` works on HTTP routes and on GraphQL resolvers (`@UseGuards(RateLimitGuard)` on a resolver method or class): on a resolver it reads the request from `ctx.http` (the default key is `ctx.http.ip`), puts the `RateLimit-*` headers on the GraphQL HTTP response, keeps one counter per resolver field that has `@RateLimit()`, and a denial is `RATE_LIMITED`. It uses the same module options and `@RateLimit()` overrides, sets the same `RateLimit-*` headers on the handler's response and keeps counters separate from the middleware's; `middleware: false` turns the global middleware off when only the guard should count.

Browsers on other origins can only read the `RateLimit-*` and `Retry-After` headers if CORS exposes them:

```ts
CorsModule.forRoot({
  origin: 'https://app.example',
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
});
```

`bun add @hpmws/core @hpmws/http @hpmws/rate-limit` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
