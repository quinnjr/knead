# @knead-js/rate-limit

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
