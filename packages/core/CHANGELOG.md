# @knead-js/core

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
