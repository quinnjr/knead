# @knead-js/schedule

## 0.4.0

### Patch Changes

- 141cdf4: Core review fixes. `redactValue()` now redacts URLs (their userinfo), `Request`/`Response` objects (method or status, url, headers), objects whose `toJSON()` returns a string, and the own properties of other class instances, with a 20000-node budget per call. `redactCredentials()` uses one normalized key vocabulary for `key=value` pairs and object keys (adding `credential`, `sessionid`, `privatekey`, `api-key`/`x-api-key`, `AccessKey`, `SharedAccessKey`, `pass`, `passphrase`, `jwt` and `sig`). It also redacts JSON- and YAML-shaped `key: value` pairs, quoted values up to their closing quote, `Authorization:`/`Cookie:` header line values whatever their scheme, and URL userinfo after a scheme that starts with a non-letter or runs past 32 characters. The injector stops tracking the transients of a construction that is retried after an async dependency settles. Once `close()` has begun during `initializeLate()`, no further startup hook starts, and an instance whose `onModuleInit` finishes afterwards gets its shutdown hooks. When the cleanup after a failed startup hook also fails, its error is kept as `shutdownError` on the original error. Async factory overrides of `LOGGER`/`DEVELOPMENT` are awaited, and on `resolveOrConstruct()` they raise `ProviderConfigError`. Invalid provider scopes are rejected, and a module's own provider wins over a re-exported child's. `DeferredLogger.attach()` delivers every held warning even when one `warn` throws. `sendRedisCommand()` validates `timeoutMs` and passes `send` a `RedisDeadline`, so `RedisStore` never sends its `EVAL` fallback after the timeout. The new `ownedRedisClientOptions()` is used by both Redis stores; `RedisLockStore`'s own client now has a `connectionTimeout`, and a supplied client is no longer connected by the store.
- 141cdf4: Review fixes for scheduling, rate limiting and CORS.
  
  - **core:** new `parseDuration(value, { label, error })`, `Duration`, `ParseDurationOptions` and
    `MAX_DURATION_MS`, the duration parser `@knead-js/schedule` and `@knead-js/rate-limit` now share
    (their own `parseDuration` exports are unchanged).
  - **schedule:** a cron job armed during the second occurrence of a repeated (fall-back) hour now
    skips the rest of that hour, as an instance running through it does, so a `lock: true` job can
    no longer run twice across replicas. An `AbortSignal` listener on a job's `signal` can no longer
    add, resume or arm a job while the scheduler shuts down.
  - **rate-limit:** a store outage logs the first failure, then at most one line every 10 seconds
    with the count of failures not logged, then one line on recovery, instead of one warning per
    request. A `RateLimitGuard` check without `@RateLimit()` counts once per HTTP request, so a
    guarded nested GraphQL field no longer consumes one token per resolved item.
  - **cors:** a string origin that can never equal a browser's `Origin` header (a trailing slash,
    uppercase, a path, a default port) is a `CorsConfigError` naming the canonical form, and a
    non-boolean `credentials` is rejected.
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
  - @knead-js/core@0.4.0

## 0.3.0

### Minor Changes

- bebabd2: Add `DeferredLogger` and `WarnLogger` to `@knead-js/core`: warnings of an object built outside dependency injection are held until a module attaches the application's logger. `RedisStore` uses it, and `RedisLockStore` now does too: its plaintext-connection warning goes to the scheduler's logger (the `logger` option or the application's `LOGGER`) through the new optional `ScheduleLockStore.setLogger()`, which `ScheduleModule` calls at startup, instead of always to a `ConsoleLogger`. Security headers place CSP nonces structurally instead of through a line-feed placeholder, and transient tracking uses scoped counters instead of a mutable `bootstrapping` flag and a stack scan.

### Patch Changes

- 404aa0d: Fix conformance gaps found by a project-wide audit:
  
  - `redactValue` no longer returns a `Headers`, `Map` or other entries-like object unredacted at the depth limit or inside a cycle, and now redacts non-`Error` causes and `AggregateError.errors` deeper in a cause chain.
  - `JsonLogger` in development no longer hangs on an error that contains itself, and nested errors share the depth limit (at most 100 detailed errors per record).
  - Transients resolved after startup are no longer tracked for lifecycle hooks (an unbounded leak).
  - WebSocket endpoints are reachable behind a covering `/:param` or wildcard GET route; an explicit `undefined` no longer overrides WebSocket defaults; upgrade slots of sockets that never open are released.
  - CORS origin predicates, GraphQL `refreshContext` and revocation checks fail closed on non-`true`/non-object results.
  - More options are validated at startup instead of failing per request: route `status`, `defaultCacheControl`, security-header and CSP values Bun cannot send, CORS `origin`, rate-limit `store`/`key`/`middleware`, `sweepIntervalMs`, GraphQL `cacheControl`/CSRF headers/timeouts, sanitize preset names, `PrismaModule.forRootAsync` and `TransactionHost.run` `isolationLevel`.
  - The rate-limit Redis store's own client no longer queues commands while Redis is unreachable; the scheduler logs through the application `LOGGER`; cron jobs no longer re-fire during a DST fall-back hour; cron patterns are capped at 1024 characters.
  - Per-request work is cached (CORS and security headers, playground pages, interface resolution, route 405 lookup), and packages gain npm keywords, homepages and Bun-oriented descriptions.
- d35aafe: Add `sendRedisCommand()` to `@knead-js/core` (the connect-then-send-with-timeout step that `RedisStore` and `RedisLockStore` now share) and `isHeaderValue()` to `@knead-js/http`. GraphQL's `cacheControl` option is now validated with `isHeaderValue()`, so a value with a leading or trailing line feed is rejected at bootstrap like any other CR or LF. Internal simplifications: the route compiler adds the default `Cache-Control` once per handler, security headers send their prebuilt list as is when there is no nonce, and a cron job builds its timezone formatter only when it is first needed.
- Updated dependencies [404aa0d]
- Updated dependencies [bebabd2]
- Updated dependencies [d35aafe]
  - @knead-js/core@0.3.0

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
