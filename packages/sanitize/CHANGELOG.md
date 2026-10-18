# @knead-js/sanitize

## 0.5.0

### Minor Changes

- 151bf6c: **Breaking:** `@Injectable()` is now required on every class the container constructs as a
  provider, whether listed in `providers` or used through `useClass` (including testing overrides).
  An unmarked class is a `ProviderConfigError` at bootstrap naming the class and module. Value,
  factory and alias providers, and guard, middleware and filter classes, need no decorator.
  `@Controller()`, `@Resolver()` and `@Catch()` mark their classes. New `markInjectable(metadata)`
  lets other class decorators do the same; `normalizeProvider()` takes an optional `owner` for its
  error messages.

## 0.4.0

No changes in this release.

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

## 0.2.1

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.0

### Minor Changes

- aec5edd: Initial release of the Knead framework: DI and modules, HTTP(S) with schema-typed REST controllers, CORS, rate limiting, security headers, HTML sanitization and testing utilities.
- 690f12a: The framework formerly called hpmws is now Knead, and the packages are published as `@knead-js/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:
  
  - `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
  - Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
  - The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
  - `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
  - The Standard Schema `vendor` of `@knead-js/sanitize` schemas is `knead`.
- 0f476dc: `xmp`, `noembed`, `noframes`, `plaintext`, `title`, `frame`, `frameset`, `applet` and `portal` can no longer be allowed. URL schemes are an allowlist (`http`, `https`, `mailto`, `tel`; extend it with `extraSchemes`) checked on every URL attribute (`href`, `src`, `cite`, `action`, `background`, `poster`, `data`, `xlink:href`, `formaction`, `ping`). Policies that allow `id` or `name` must set `allowClobberingAttributes: true`.
- 60dac85: Publish under the `@knead-js` npm scope (`@knead` was not available). Package imports change from `@knead/<name>` to `@knead-js/<name>`; the framework is still called Knead, and class names (`KneadFactory`, `KneadError`) and the `knead:` metadata, Redis and logger namespaces are unchanged.

### Patch Changes

- 2fd4926: Every package requires Bun `>=1.4.3` (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), bare-LF chunked request smuggling and other server bugs. `listen()` logs a one-time warning on older Bun versions; `checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported from `@knead-js/http`.
- 2fd4926: `sanitize-html` is pinned exactly to `2.18.1` and `dataloader` to `2.2.3`: neither is published with provenance, so exact pins keep a hijacked release from reaching consumers.
