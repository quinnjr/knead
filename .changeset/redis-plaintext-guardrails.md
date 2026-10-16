---
"@hpmws/http": minor
"@hpmws/graphql": minor
"@hpmws/rate-limit": minor
---

`@hpmws/http` exports `plaintextRedisHost()` (plus `isLoopbackHostname()` and `defaultRedisUrl()`), used by `RedisPubSub` and now also `RedisStore` to warn about plaintext `redis://`/`valkey://` URLs to non-loopback hosts (IPv4-mapped loopback included). Both accept `requireTls: true` to throw instead. `RedisStore` accepts a `logger`.
