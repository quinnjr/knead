# @knead-js/rate-limit

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
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
  - @knead-js/core@0.4.0
  - @knead-js/http@0.4.0

## 0.3.0

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
  - @knead-js/http@0.3.0

## 0.2.1

### Patch Changes

- @knead-js/core@0.2.1
  - @knead-js/http@0.2.1

## 0.2.0

### Patch Changes

- f779f8a: `RateLimitModule.forRoot()` rejects an unknown `onStoreError` or `algorithm` with a `RangeError`. A typo in `onStoreError` (anything but `'deny'`) silently failed open, and a typo in `algorithm` silently used the sliding window.
- Updated dependencies [f779f8a]
- Updated dependencies [5296955]
- Updated dependencies [f779f8a]
- Updated dependencies [7b77d69]
- Updated dependencies [5296955]
- Updated dependencies [82ce070]
- Updated dependencies [871883c]
  - @knead-js/core@0.2.0
  - @knead-js/http@0.2.0

## 0.1.0

### Minor Changes

- aec5edd: Initial release of the Knead framework: DI and modules, HTTP(S) with schema-typed REST controllers, CORS, rate limiting, security headers, HTML sanitization and testing utilities.
- 2fd4926: New `RateLimitGuard` (usable with `@UseGuards()` or as `APP_GUARD`) applies the module's limits and `@RateLimit()` overrides in the guard phase, so key functions can read `ctx.state` set by earlier guards (per-user limits). `forRoot({ middleware: false })` disables the global middleware. The shared check is exported as `RateLimiter`.
- 0f476dc: The default key masks IPv6 addresses to a /64 (`ipv6Subnet`). `MemoryStore` and `RedisStore` hash keys with SHA-256 by default (`hashKeys`). `onMissingKey: 'skip' | 'shared' | 'deny'` (default `'shared'`, one anonymous bucket per scope) replaces the old skip-when-keyless behaviour. Durations above one year are a `RangeError`. `maskIp`, `hashKey`, `MAX_DURATION_MS` and `validateRateLimitOptions` are exported.
- 2fd4926: Store-key hashing is keyed: `hashKey(key, secret?)` is HMAC-SHA256 under a secret, `MemoryStore` uses a random per-process secret, and `RedisStore` takes `hashSecret` (at least 32 bytes, shared across instances). Without it `RedisStore` falls back to plain SHA-256 and logs a one-time warning that IPs are recoverable from the Redis keys. The docs no longer claim an unkeyed hash hides client IPs.
- 690f12a: The framework formerly called hpmws is now Knead, and the packages are published as `@knead-js/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:
  
  - `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
  - Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
  - The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
  - `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
  - The Standard Schema `vendor` of `@knead-js/sanitize` schemas is `knead`.
- 2fd4926: `@knead-js/http` exports `plaintextRedisHost()` (plus `isLoopbackHostname()` and `defaultRedisUrl()`), used by `RedisPubSub` and now also `RedisStore` to warn about plaintext `redis://`/`valkey://` URLs to non-loopback hosts (IPv4-mapped loopback included). Both accept `requireTls: true` to throw instead. `RedisStore` accepts a `logger`.
- 2fd4926: Redis commands are bounded: `RedisStore` gets `commandTimeout` (default 250 ms; a timeout is a store error, so `onStoreError` applies) and `RedisPubSub` gets `publishTimeout` (default 2000 ms; `publish()` logs and resolves, `publishOrThrow()` rejects).
- 60dac85: Publish under the `@knead-js` npm scope (`@knead` was not available). Package imports change from `@knead/<name>` to `@knead-js/<name>`; the framework is still called Knead, and class names (`KneadFactory`, `KneadError`) and the `knead:` metadata, Redis and logger namespaces are unchanged.

### Patch Changes

- 2fd4926: Every package requires Bun `>=1.4.3` (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), bare-LF chunked request smuggling and other server bugs. `listen()` logs a one-time warning on older Bun versions; `checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported from `@knead-js/http`.
- 2fd4926: Framework error logging goes through one helper, `logError()` (exported, and injectable as `ErrorLog`): outside development it logs only the error's name and its message (redacted, then capped at 500 characters) under a correlation id, never the error object; in development the full error, redacted. The http pipeline, WebSocket registry, rate-limit store errors, GraphQL errors, subscriptions, Leaven's diagnostics and `RedisPubSub` use it, so redaction no longer depends on the configured logger. 5xx problem bodies carry the `correlationId`, and development 500 `detail`/`stack` are redacted. `RedisPubSub` logs topics JSON-quoted.
- 2fd4926: `websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` must be 1 to 128: 0 put every IPv6 client into one group and is now a configuration error.
- 0f476dc: `maskIp(ip, prefix)` throws a `RangeError` unless the prefix is an integer from 0 to 128, and returns IPv4-mapped input (`::ffff:1.2.3.4`) in its IPv4 form, so it shares a key with `1.2.3.4`. `websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` accept the same range (0 to 128), checked by the new exported `isIpv6Prefix`.
- 2fd4926: `RateLimitGuard` works on GraphQL resolvers: it reads the IP from `ctx.http`, sets the `RateLimit-*` headers on `ctx.http.res`, uses the resolver's `@RateLimit()` metadata with one counter per field, and no longer assumes `ctx.res` exists.
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [0f476dc]
- Updated dependencies [aec5edd]
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [690f12a]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [60dac85]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
- Updated dependencies [2fd4926]
  - @knead-js/http@0.1.0
  - @knead-js/core@0.1.0
