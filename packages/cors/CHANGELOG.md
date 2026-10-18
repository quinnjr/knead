# @knead-js/cors

## 0.5.0

### Minor Changes

- 151bf6c: **Breaking:** `@Injectable()` is now required on every class the container constructs as a
  provider, whether listed in `providers` or used through `useClass` (including testing overrides).
  An unmarked class is a `ProviderConfigError` at bootstrap naming the class and module. Value,
  factory and alias providers, and guard, middleware and filter classes, need no decorator.
  `@Controller()`, `@Resolver()` and `@Catch()` mark their classes. New `markInjectable(metadata)`
  lets other class decorators do the same; `normalizeProvider()` takes an optional `owner` for its
  error messages.

### Patch Changes

- Updated dependencies [151bf6c]
  - @knead-js/core@0.5.0
  - @knead-js/http@0.5.0

## 0.4.0

### Patch Changes

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

- 0f476dc: `Origin` headers longer than 2048 characters (`MAX_ORIGIN_LENGTH`) are treated as disallowed. The README documents that RegExp origins must be anchored and linear.
- 2fd4926: A RegExp `origin` that does not start with `^` and end with `$` is now a `CorsConfigError` at `forRoot()` (it matched anywhere in the Origin, e.g. `https://app.example.evil`).
- aec5edd: Initial release of the Knead framework: DI and modules, HTTP(S) with schema-typed REST controllers, CORS, rate limiting, security headers, HTML sanitization and testing utilities.
- 690f12a: The framework formerly called hpmws is now Knead, and the packages are published as `@knead-js/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:
  
  - `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
  - Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
  - The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
  - `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
  - The Standard Schema `vendor` of `@knead-js/sanitize` schemas is `knead`.
- 60dac85: Publish under the `@knead-js` npm scope (`@knead` was not available). Package imports change from `@knead/<name>` to `@knead-js/<name>`; the framework is still called Knead, and class names (`KneadFactory`, `KneadError`) and the `knead:` metadata, Redis and logger namespaces are unchanged.

### Patch Changes

- 2fd4926: Every package requires Bun `>=1.4.3` (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), bare-LF chunked request smuggling and other server bugs. `listen()` logs a one-time warning on older Bun versions; `checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported from `@knead-js/http`.
- 2fd4926: A RegExp `origin` with a top-level `|` (such as `/^https:\/\/a\.com|https:\/\/b\.com$/`, where each anchor covers only one side) is a `CorsConfigError` telling you to wrap it as `^(?:a|b)$`.
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
