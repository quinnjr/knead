# @knead-js/graphql

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

### Minor Changes

- 1ee1275: Add `@knead-js/casl`: CASL authorization with a permission catalog (`definePermissions`), token grants narrowing each user's abilities (`validateGrant`, which also checks the fields a grant names and reports them as `GrantProblem.field`, and `fullGrant`), `AbilityGuard`/`@Can`/`@SkipAbility` for REST routes and GraphQL root fields (as an app-wide guard it passes the GraphQL endpoint when `GraphQLModule` runs `AbilityGuard` on its resolvers) (`createCan<Actions, Subjects>()` for a typed `@Can`), `@PermittedFields` for REST responses, `@AbilitySubject` field-level rules for GraphQL object types, and `CaslForbiddenFilter`/`mapCaslError` reporting CASL's `ForbiddenError` as a plain 403/`FORBIDDEN`. It re-exports `ForbiddenError` and `subject` (and the `AbilityBuilder`, `MongoAbility` and `RawRuleOf` types) from its own pinned `@casl/ability`.
  
  `@knead-js/graphql`: add a `mapError` option that maps errors thrown by resolver code, hooks, subscription filters and the WebSocket `context` factory to an `HttpException` before masking, `@UseFieldGuards()` field guards on object types (`FIELD_GUARDS` route-meta key, holding a frozen guard list), and a `GRAPHQL_ENDPOINT` route-meta entry on the endpoint exposing the module guards to app-wide HTTP guards.

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

- 2fd4926: New opt-in `authorize` guards on HTTP routes and GraphQL resolvers, run after validation so they see the validated, transformed input (`ctx.body`/`ctx.query`/... or `ctx.args`). Ordinary guards still run before validation; the READMEs document the order.
- 2fd4926: Subscription event payloads are deep-frozen when they arrive (in-memory `PubSub` and `RedisPubSub`), so one subscriber's resolver cannot change what the others receive. `deepFreeze` is exported.
- 0f476dc: Security hardening:
  
  - Safe default limits: `maxDepth` 10, `maxComplexity` 1000, `parseOptions.maxTokens` 10000, `maxQueryLength` 100 KiB (HTTP and WebSocket) and `maxAliases` 30; `Infinity` or `false` disables one. The depth check is Knead's own and does not count selections inside `__schema`/`__type`, so `getIntrospectionQuery()` passes. Exported as `GRAPHQL_LIMITS`.
  - WebSocket: the same-origin check is `@knead-js/http`'s `originAllowed` (default ports normalized); a second `connection_init` closes with 4429; subscriptions that resolve after close or after `complete` are returned at once; a reused id returns the earlier iterator; `subscriptions.messageRate` and `subscriptions.maxConnectionLifetime` are passed to `WsRegistry`.
  - Resolver guards pass only on `=== true`. New module-level `guards`, `defaultDeny` and `@Public()` (`ctx.meta[IS_PUBLIC]`).
  - Revocation: `@Subscription({ recheckGuards: true })` and the injectable `GraphQLSubscriptions.closeWhere(predicate, code?, reason?)`, which is re-applied to sockets whose `onConnect` was still pending.
  - `onConnect` receives read-only `ConnectionParams` and returns `boolean | Partial<GraphQLContext>`; returning or spreading the params is a type error.
  - Topics computed by a topic function may not contain `*` or `#` (BAD_USER_INPUT).
  - GraphQL responses send `cache-control: no-store` (option `cacheControl`) and `x-content-type-options: nosniff`.
  - `RedisPubSub`: `publish()` never rejects (new `publishOrThrow()`), a warning for plain `redis://` to a non-loopback host, and optional HMAC-SHA256 message signing (`signingKey`) over the prefixed channel, a timestamp and the payload, with `maxSignatureAge` (default 60s).
  - Playground: `playground: { subscriptionEndpoint }`; otherwise the URL is derived only from a plain `host[:port]` Host header. Enabling it outside development logs a warning.
  - The playground, introspection, error masking and schema-file defaults follow the application's `HTTP_DEVELOPMENT` flag (NODE_ENV only when it is absent).
  - Outside development, internal errors are logged as name, truncated message and a correlation id (also returned as `extensions.correlationId`), never as objects.
  - Leaven packages are pinned exactly: `@leaven-graphql/core` and `ws` to `0.2.3`, `playground` to `0.2.2`, `@leaven-graphql/errors` to `0.2.1`.
- 2fd4926: New `maxIntrospectionDepth` (default 20, headroom above the depth 15 of `getIntrospectionQuery()`): selections under `__schema`/`__type`, which `maxDepth` does not count, are capped separately, so introspection bombs are `DEPTH_LIMIT`.
- 2fd4926: New `maxFields` limit (default 1000, `FIELD_LIMIT`): field selections, with fragments expanded, are counted right after parsing, so oversized documents are rejected before the quadratic overlapping-fields validation and before Leaven caches them. `parseOptions.maxTokens` now defaults to 3000 (was 10000), and the document cache to `{ maxSize: 100 }`.
  
  **New default limits.** Documents with more than 1000 fields or 3000 tokens are now rejected. Raise them with `GraphQLModule.forRoot({ maxFields: 5000, parseOptions: { maxTokens: 20000 } })` (or disable one with `Infinity`/`false`). Relay clients and persisted-query sets with large generated documents are the most likely to need higher values.
- 0f476dc: Add `@knead-js/graphql`: code-first GraphQL on Leaven with compile-time checked field types, DI resolvers, DataLoader batching, guards, error mapping, CSRF-safe HTTP transport, a hashed-CSP playground, and graphql-transport-ws subscriptions with in-memory or Redis pub/sub. `@knead-js/core` adds the `MODULES` injection token, and `@knead-js/testing` adds `app.graphql()` and `app.graphqlSubscribe()`.
- 2fd4926: The playground's inline script is pinned by sha256 (`PLAYGROUND_SCRIPT_HASHES`, recomputed with `playgroundScriptHashes()`): when Leaven's script differs, the gate logs once at bootstrap and answers 503, as it already did for unpinned assets.
- 2fd4926: New `subscriptions.refreshContext({ http, context })`, called before every recheck of a `recheckGuards: true` subscription: its result is merged over the operation's context, and `false` ends the subscription with FORBIDDEN. The README states that rechecked guards otherwise see the connect-time identity.
- 690f12a: The framework formerly called hpmws is now Knead, and the packages are published as `@knead-js/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:
  
  - `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
  - Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
  - The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
  - `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
  - The Standard Schema `vendor` of `@knead-js/sanitize` schemas is `knead`.
- 2fd4926: `@knead-js/http` exports `plaintextRedisHost()` (plus `isLoopbackHostname()` and `defaultRedisUrl()`), used by `RedisPubSub` and now also `RedisStore` to warn about plaintext `redis://`/`valkey://` URLs to non-loopback hosts (IPv4-mapped loopback included). Both accept `requireTls: true` to throw instead. `RedisStore` accepts a `logger`.
- 2fd4926: `RedisPubSub` reports dropped messages at most once per 10s per instance (with a count), and rejects messages over the new `maxMessageBytes` (default 1 MiB) before any HMAC, decryption or JSON work.
- 2fd4926: `RedisPubSub` gets optional payload encryption: `encryptionKey` (one key or an array for rotation, at least 32 bytes) encrypts each payload with AES-256-GCM, a random 12-byte IV and the channel as AAD. It combines with `signingKey` (encrypt, then sign the envelope); messages that fail to decrypt are dropped and logged.
- 2fd4926: `RedisPubSub` `signingKey` accepts an array for rotation (sign with the first key, verify with any), copies `Uint8Array` keys at construction, and `maxSignatureAge` must be between 1 ms and 10 minutes.
- 2fd4926: Redis commands are bounded: `RedisStore` gets `commandTimeout` (default 250 ms; a timeout is a store error, so `onStoreError` applies) and `RedisPubSub` gets `publishTimeout` (default 2000 ms; `publish()` logs and resolves, `publishOrThrow()` rejects).
- 60dac85: Publish under the `@knead-js` npm scope (`@knead` was not available). Package imports change from `@knead/<name>` to `@knead-js/<name>`; the framework is still called Knead, and class names (`KneadFactory`, `KneadError`) and the `knead:` metadata, Redis and logger namespaces are unchanged.

### Patch Changes

- 2fd4926: Every package requires Bun `>=1.4.3` (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), bare-LF chunked request smuggling and other server bugs. `listen()` logs a one-time warning on older Bun versions; `checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported from `@knead-js/http`.
- 2fd4926: Framework error logging goes through one helper, `logError()` (exported, and injectable as `ErrorLog`): outside development it logs only the error's name and its message (redacted, then capped at 500 characters) under a correlation id, never the error object; in development the full error, redacted. The http pipeline, WebSocket registry, rate-limit store errors, GraphQL errors, subscriptions, Leaven's diagnostics and `RedisPubSub` use it, so redaction no longer depends on the configured logger. 5xx problem bodies carry the `correlationId`, and development 500 `detail`/`stack` are redacted. `RedisPubSub` logs topics JSON-quoted.
- 2fd4926: `sanitize-html` is pinned exactly to `2.18.1` and `dataloader` to `2.2.3`: neither is published with provenance, so exact pins keep a hijacked release from reaching consumers.
- 2fd4926: Docs: `@Public()` is GraphQL-only (HTTP global guards still apply), and `defaultDeny` protects entry points only, so sensitive `@ResolveField`/`@Field` data needs its own guards.
- 2fd4926: `GraphQLConnection.context` (what `GraphQLSubscriptions.closeWhere` predicates match) is the merged identity: the `context(http)` factory result, computed once at connection init, plus the `onConnect` result. `closeWhere` logs at debug level when it matches no socket.
- 2fd4926: The per-socket cap on revocations deferred until a GraphQL socket's init completes is the registry's `websocket.maxPendingRevocations` (default 10000, exposed as `WsRegistry.maxPendingRevocations`) instead of a fixed 100; overflow still fails closed with 1008.
- 2fd4926: Revocations deferred until a subscription socket's init completes are capped at 100 per socket; past that the socket is closed with 1008 (fail closed).
- 2fd4926: `deepFreeze` (and so subscription payload freezing) freezes only plain objects and arrays, and leaves publisher-owned class instances, Dates, Maps, Buffers and ORM graphs unfrozen.
- 0f476dc: Upgrade Leaven to 0.2.2: the playground loads `graphql-playground-react` 1.7.28 (fixes CVE-2021-41249) with re-pinned integrity hashes, Leaven's caches no longer key on a collidable 64-bit hash, and its WebSocket handler, subscription manager and the default in-memory `PubSub` now log through `LOGGER`.
- 2fd4926: Upgrade Leaven core and ws to 0.2.3: subscription ids are validated (`^[A-Za-z0-9_.:-]{1,64}$`, otherwise close 4400), client-controlled values are escaped in Leaven's log and error text, documents and compiled queries are cached only after validation, depth and complexity pass, and both caches are bounded by bytes.
- 2fd4926: `maxFields` also counts the field nodes written in every operation and fragment definition, including fragments that are never spread (validation visits them all).
- 2fd4926: The playground's CSP no longer allows Google Fonts (the page uses system fonts), and the page is sent with `referrer-policy: no-referrer`. The README notes that the playground keeps tabs and headers in `localStorage`.
- 2fd4926: `recheckGuards: true` also re-runs a subscription's `authorize` guards, after `guards`, against the validated arguments.
- 2fd4926: Computed subscription topics longer than 256 characters are rejected with `BAD_USER_INPUT`, next to the wildcard check.
- 2fd4926: The 4400 close for malformed subscription ids uses Leaven's reason ("Invalid message"); it is a duplicate safety net in front of Leaven's own check.
- 2fd4926: A WebSocket `subscribe` or `complete` message whose id does not match `^[A-Za-z0-9_.:-]{1,64}$` closes the socket with 4400 before it reaches Leaven (ids end up in logs).
- 2fd4926: Every GraphQL operation over a WebSocket gets its own view of the upgrade `ctx.http` with a fresh `state`, so `ctx.http.state` written in one operation is not visible in the next.
- 2fd4926: Each WebSocket operation's `ctx.http.state` starts as a shallow copy of the upgrade request's state, so values set by middleware and guards at upgrade time (`context: (http) => ({ user: http.state.user })`) are visible again, while operations still never see each other's writes.
- 2fd4926: Guard references are validated at `listen()` (HTTP) and bootstrap (GraphQL): anything but an object with `canActivate()`, a function, or a class with `canActivate()` on its prototype (for example `undefined` from a circular import, or an arrow-function field) is an `HttpConfigError` naming the controller, route or resolver. `assertGuardRef()` is exported.
- 2fd4926: New `listen({ validation: { redactIssueMessages: true } })` replaces body and query validation issue messages with `Invalid value` (paths kept), so schemas that quote input never echo it. The GraphQL README notes that graphql-js coercion errors quote values.
- 2fd4926: `RedisPubSub` encrypted envelopes carry an authenticated timestamp and are refused after `maxSignatureAge`, so encryption-only messages can no longer be replayed indefinitely. The docs give the safe key rotation order (`[old, new]` → `[new, old]` → `[new]`) and the remaining replay window.
- 2fd4926: `RedisPubSub` isolates throwing `onError` callbacks (logged; the other listeners are still told), and a failing queued SUBSCRIBE/UNSUBSCRIBE no longer stalls its topic's queue. A listener whose graceful stop rejects during `close()` is logged instead of leaving an unhandled rejection.
- 2fd4926: `RedisPubSub` warns at construction when it has no `signingKey` and its Redis server is not on loopback.
- 2fd4926: `closeWhere` predicates kept for upgrading sockets are applied before the endpoint's `open` runs, and fail closed: when one newer than the socket's upgrade was already evicted or expired (or the upgrade took over 30s), the socket is closed with 1008 "Revocation state unavailable". Upgrades that never open no longer keep the in-progress count up (30s TTL). GraphQL sockets revoked before they opened are checked again once their init completes.
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
