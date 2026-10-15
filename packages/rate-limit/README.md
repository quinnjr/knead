# @hpmws/rate-limit

`RateLimitModule.forRoot({ limit, window })` with sliding-window or token-bucket algorithms, `@RateLimit()` (validated at decoration time) / `@SkipRateLimit()`, standard `RateLimit-*` headers and `Retry-After` computed from the earliest admission time, and `MemoryStore` or `RedisStore` (atomic Lua on `Bun.redis`) for multi-instance deployments. Windows are integer milliseconds (durations are rounded up). `RedisStore` is not compatible with Redis Cluster.

`bun add @hpmws/rate-limit`. Licensed MIT OR Apache-2.0.
