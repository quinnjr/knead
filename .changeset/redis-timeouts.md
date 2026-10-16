---
"@hpmws/graphql": minor
"@hpmws/rate-limit": minor
---

Redis commands are bounded: `RedisStore` gets `commandTimeout` (default 250 ms; a timeout is a store error, so `onStoreError` applies) and `RedisPubSub` gets `publishTimeout` (default 2000 ms; `publish()` logs and resolves, `publishOrThrow()` rejects).
