---
'@knead-js/core': minor
'@knead-js/schedule': minor
'@knead-js/security-headers': patch
---

Add `DeferredLogger` and `WarnLogger` to `@knead-js/core`: warnings of an object built outside dependency injection are held until a module attaches the application's logger. `RedisStore` uses it, and `RedisLockStore` now does too: its plaintext-connection warning goes to the scheduler's logger (the `logger` option or the application's `LOGGER`) through the new optional `ScheduleLockStore.setLogger()`, which `ScheduleModule` calls at startup, instead of always to a `ConsoleLogger`. Security headers place CSP nonces structurally instead of through a line-feed placeholder, and transient tracking uses scoped counters instead of a mutable `bootstrapping` flag and a stack scan.
