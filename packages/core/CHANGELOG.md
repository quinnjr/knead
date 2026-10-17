# @knead-js/core

## 0.2.0

### Minor Changes

- 7b77d69: Add `@knead-js/prisma`: `PrismaModule.forRoot()` / `forRootAsync()` and `PrismaService`, which connects the Prisma 7 client at bootstrap and disconnects it on shutdown; `TransactionHost` and `@Transactional()` for ambient transactions (`required` and `requiresNew` propagation); `@knead-js/prisma/http` with `PrismaHttpModule`, `PrismaExceptionFilter` and `toHttpException`, mapping Prisma errors to problem responses without exposing their messages; and `@knead-js/prisma/testing` with `withRollback`. Register your client type through `PrismaClientRegistry` to type `PrismaService.db`.
  
  `@knead-js/core` now owns `LOGGER`, `Logger`, `ConsoleLogger`, `MemoryLogger`, `logError` and the `DEVELOPMENT` token, and `ApplicationContext.create` provides a default `LOGGER` and `DEVELOPMENT` and accepts `logger` and `development` options. `@knead-js/http` re-exports the same objects.
  
  `@knead-js/http` exception filters can now decline by returning `undefined`, so later filters and the default mapping still run, and `defaultErrorResponse` is exported. `ExceptionFilter.catch` is typed `Response | undefined | Promise<Response | undefined>` (was `Response | Promise<Response>`). Behaviour change: a filter that returns `undefined` used to be logged as "did not return a Response" and stop the chain with the default mapping; it now passes the error on to the next filter without logging. Other non-`Response` values are still logged and stop the chain.
  
  `HTTP_DEVELOPMENT` is now an alias of core's `DEVELOPMENT` (the same token object), so its description is `'DEVELOPMENT'` rather than `'HTTP_DEVELOPMENT'`; `NoProviderError` messages and other token names in error text change accordingly.
  
  `TransactionHost.run` marks a joined (`required`) transaction rollback-only when an inner run rejects: if the owning run then resolves, the transaction rolls back and the owning run rejects with a `KneadError` whose `cause` is the inner rejection.
- 82ce070: Add `@knead-js/schedule`: `@Cron`, `@Interval` and `@Timeout` jobs discovered on providers, an injectable `SchedulerRegistry` to add, pause, resume, trigger and remove jobs at runtime, graceful shutdown that waits for runs in progress, and optional `MemoryLockStore`/`RedisLockStore` locks so each cron firing runs on one instance. `parseIp`, `isLoopbackHostname`, `plaintextRedisHost`, `defaultRedisUrl` and the log redaction helpers (`redactCredentials`, `redactValue`, `summarizeError`, `logValue`) move to `@knead-js/core`; `@knead-js/http` still re-exports them.

### Patch Changes

- f779f8a: `ConsoleLogger` redacts credentials in its fallback output too. When formatting a log call failed (for example a non-string message from untyped code), the message was printed escaped but not redacted, so a URL password in it reached the console. A message that cannot be stringified is now printed as `[unloggable message]`.
  
  In development, `logError()` passes an error that needed redacting to the logger as an `Error` (its message redacted and its stack the redacted stack, causes and properties) instead of a string, so loggers format every error the same way: `JsonLogger` writes it under `err` like any other error rather than as a `meta` string.
- 5296955: `redactValue` (and so every logger) now treats any key containing a secret word as sensitive, whatever its case or separators (`db_password`, `userPassword`, `x-api-key`, `clientSecret`, `access_token`, `sessionId`); such keys keep number and boolean values. Credentials in object, Map and Error property keys are redacted, and an Error whose cause chain is longer than 16 is always printed redacted and truncated, never raw.

## 0.1.0

### Minor Changes

- 0f476dc: Add `@knead-js/graphql`: code-first GraphQL on Leaven with compile-time checked field types, DI resolvers, DataLoader batching, guards, error mapping, CSRF-safe HTTP transport, a hashed-CSP playground, and graphql-transport-ws subscriptions with in-memory or Redis pub/sub. `@knead-js/core` adds the `MODULES` injection token, and `@knead-js/testing` adds `app.graphql()` and `app.graphqlSubscribe()`.
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
