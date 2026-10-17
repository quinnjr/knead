# @knead-js/schedule

## 0.2.1

### Patch Changes

- @knead-js/core@0.2.1

## 0.2.0

### Minor Changes

- 82ce070: Add `@knead-js/schedule`: `@Cron`, `@Interval` and `@Timeout` jobs discovered on providers, an injectable `SchedulerRegistry` to add, pause, resume, trigger and remove jobs at runtime, graceful shutdown that waits for runs in progress, and optional `MemoryLockStore`/`RedisLockStore` locks so each cron firing runs on one instance. `parseIp`, `isLoopbackHostname`, `plaintextRedisHost`, `defaultRedisUrl` and the log redaction helpers (`redactCredentials`, `redactValue`, `summarizeError`, `logValue`) move to `@knead-js/core`; `@knead-js/http` still re-exports them.

### Patch Changes

- Updated dependencies [f779f8a]
- Updated dependencies [7b77d69]
- Updated dependencies [5296955]
- Updated dependencies [82ce070]
  - @knead-js/core@0.2.0
