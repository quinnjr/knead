# @hpmws/rate-limit

`RateLimitModule.forRoot({ limit, window })` with sliding-window or token-bucket algorithms, `@RateLimit()` (validated at decoration time) / `@SkipRateLimit()`, standard `RateLimit-*` headers and `Retry-After` computed from the earliest admission time, and `MemoryStore` or `RedisStore` (atomic Lua on `Bun.redis`) for multi-instance deployments. Windows are integer milliseconds (durations are rounded up). `RedisStore` is not compatible with Redis Cluster.

In production, connect `RedisStore` with `rediss://` (TLS) as a least-privilege ACL user limited to the store's keys and the commands it runs, for example `ACL SETUSER ratelimit on >secret resetkeys ~hpmws:rl:* -@all +evalsha +eval +get +incr +pexpire +hmget +hset +time +script|load`. A plaintext `redis://` or `valkey://` URL (from `url`, `REDIS_URL` or `VALKEY_URL`) to a non-loopback host logs a warning at construction; `new RedisStore({ requireTls: true })` throws instead. A caller-supplied `client` bypasses this check, so configure TLS on it yourself.

Windows are capped at one year (`365d`); a longer one is a `RangeError` at decoration or `forRoot()` time.

The default key is the client IP (`ctx.ip`). IPv6 addresses are masked to a /64 (`ipv6Subnet`, an integer from 0 to 128, default 64; 128 keys each address; IPv4-mapped addresses are keyed as IPv4), because one client usually controls a whole /64 and could otherwise rotate addresses to reset its bucket. Both stores hash keys before storing them (32 hex characters; `hashKeys: false` keeps raw keys). `MemoryStore` uses HMAC-SHA256 under a random per-process secret, so client IPs and API keys cannot be read or recovered from a memory dump. `RedisStore` uses HMAC-SHA256 under `hashSecret` (at least 32 bytes, the same on every instance sharing the Redis server); without it, it falls back to plain SHA-256 and logs a one-time warning, because an unkeyed hash does not hide IPs (every IPv4 address can be hashed in seconds), so anyone who can read the Redis keys can recover the client IPs:

```ts
new RedisStore({ url: process.env.REDIS_URL, hashSecret: process.env.RATE_LIMIT_HASH_SECRET });
```

When the key function returns no key (for example `ctx.ip` on a Unix socket, or a custom key read from a missing header), `onMissingKey` decides: `'shared'` (default) counts the request against one anonymous bucket per scope, `'skip'` lets it through unlimited, and `'deny'` rejects it with 403. The first keyless request logs a warning.

Behind a reverse proxy or load balancer, configure `app.listen({ trustProxy })` (a hop count or a list of proxy CIDRs) so `ctx.ip` comes from `X-Forwarded-For`; otherwise every client shares the proxy's address and therefore one bucket. With a hop count, set it to exactly the number of proxies in front of the app: a request whose `X-Forwarded-For` has fewer entries than that is keyed by the socket peer (the proxy), not by a client-supplied value. Never trust more hops than you have, or clients can pick their own key. WebSocket upgrade requests count against the same per-IP bucket (CORS rejects disallowed origins before rate limiting runs).

Each `@RateLimit()` route has its own counter, keyed by its method and path. A handler reachable through several routes (several decorators, `@All()`, or the same controller mounted under two prefixes) therefore gets one budget per alias, multiplying the effective limit; put the limit on a single route, or lower it accordingly. `RedisStore` waits at most `commandTimeout` (default 250 ms) for Redis; a timeout is a store error like any other. Give a caller-supplied `client` `enableOfflineQueue: false` and a `connectionTimeout`, so commands fail fast while Redis is unreachable instead of queueing. `onStoreError` (default `'allow'`, fail open with a warning) decides what happens when the store throws: use `'deny'` (503) when the limit protects authentication (login, password reset, OTP checks), where failing open would let an attacker brute-force during a Redis outage.

Browsers on other origins can only read the `RateLimit-*` and `Retry-After` headers if CORS exposes them:

```ts
CorsModule.forRoot({
  origin: 'https://app.example',
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
});
```

`bun add @hpmws/core @hpmws/http @hpmws/rate-limit` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
