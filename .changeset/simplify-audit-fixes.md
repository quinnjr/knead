---
'@knead-js/core': minor
'@knead-js/http': minor
'@knead-js/graphql': patch
'@knead-js/rate-limit': patch
'@knead-js/schedule': patch
'@knead-js/security-headers': patch
---

Add `sendRedisCommand()` to `@knead-js/core` (the connect-then-send-with-timeout step that `RedisStore` and `RedisLockStore` now share) and `isHeaderValue()` to `@knead-js/http`. GraphQL's `cacheControl` option is now validated with `isHeaderValue()`, so a value with a leading or trailing line feed is rejected at bootstrap like any other CR or LF. Internal simplifications: the route compiler adds the default `Cache-Control` once per handler, security headers send their prebuilt list as is when there is no nonce, and a cron job builds its timezone formatter only when it is first needed.
