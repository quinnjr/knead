# @hpmws/rate-limit

`RateLimitModule.forRoot({ limit, window })` with sliding-window or token-bucket algorithms, `@RateLimit()` (validated at decoration time) / `@SkipRateLimit()`, standard `RateLimit-*` headers and `Retry-After` computed from the earliest admission time, and `MemoryStore` or `RedisStore` (atomic Lua on `Bun.redis`) for multi-instance deployments. Windows are integer milliseconds (durations are rounded up). `RedisStore` is not compatible with Redis Cluster.

The default key is the client IP (`ctx.ip`). Behind a reverse proxy or load balancer, configure `app.listen({ trustProxy })` (a hop count or a list of proxy CIDRs) so `ctx.ip` comes from the forwarded headers; otherwise every client shares the proxy's address and therefore one bucket. Browsers on other origins can only read the `RateLimit-*` and `Retry-After` headers if CORS exposes them:

```ts
CorsModule.forRoot({
  origin: 'https://app.example',
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
});
```

`bun add @hpmws/core @hpmws/http @hpmws/rate-limit` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
