---
"@knead/http": minor
"@knead/graphql": minor
"@knead/rate-limit": minor
---

`@knead/http` exports `plaintextRedisHost()` (plus `isLoopbackHostname()` and `defaultRedisUrl()`), used by `RedisPubSub` and now also `RedisStore` to warn about plaintext `redis://`/`valkey://` URLs to non-loopback hosts (IPv4-mapped loopback included). Both accept `requireTls: true` to throw instead. `RedisStore` accepts a `logger`.
