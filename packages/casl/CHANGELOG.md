# @knead-js/casl

## 0.6.0

### Patch Changes

- 1175350: - casl: `parseGrant()` walks an object grant with `for...in` and `Object.hasOwn()`, so an oversized
    object stops being read as soon as it has more pairs than the catalog has areas (it read every
    key's descriptor first). Same keys, same order.
  - casl: the README and authorization guide no longer claim nothing fails at request time: a route
    with `@PermittedFields()` but no `AbilityGuard` responds `403`.
  - prisma: the docs no longer say nothing persists inside `withRollback()`: an inner
    `propagation: 'requiresNew'` run commits for real. They also say when the client shape is
    checked: an `instance` when `forRoot()` is called, a `client` factory's result at bootstrap.
- Updated dependencies [1175350]
- Updated dependencies [1175350]
- Updated dependencies [1175350]
- Updated dependencies [f2537a3]
  - @knead-js/core@0.6.0
  - @knead-js/graphql@0.6.0
  - @knead-js/http@0.6.0

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
  - @knead-js/graphql@0.5.0

## 0.4.0

### Patch Changes

- 141cdf4: Review fixes:
  
  - `@knead-js/security-headers`: a `script-src` (or `style-src`) set to `true` gets the CSP nonce
    alone instead of inheriting the `default-src` sources.
  - `@knead-js/casl`: `validateGrant()` no longer approves a pair the user is denied by a later
    unconditional `cannot`; a method's `@Can()` now overrides its controller's `@SkipAbility()`
    (it failed open), while `@SkipAbility()` still wins on the same method or controller.
  - `@knead-js/prisma`: `withRollback()` rejects with the rollback-only `KneadError` when an inner
    `@Transactional()` call failed, even if the test function caught it, as the owning run does in
    production.
  - `@knead-js/core`: exports `errorText()` and `isPlainObject()`, now shared by
    `@knead-js/logging` and `@knead-js/prisma/http`; `redactValue()` prints an Error whose `stack`
    is not a string as `Name: message` instead of `[unloggable value: …]`.
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
  - @knead-js/core@0.4.0
  - @knead-js/graphql@0.4.0
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
  - @knead-js/graphql@0.3.0

## 0.2.1

### Patch Changes

- @knead-js/core@0.2.1
  - @knead-js/graphql@0.2.1
  - @knead-js/http@0.2.1

## 0.2.0

### Minor Changes

- 1ee1275: Add `@knead-js/casl`: CASL authorization with a permission catalog (`definePermissions`), token grants narrowing each user's abilities (`validateGrant`, which also checks the fields a grant names and reports them as `GrantProblem.field`, and `fullGrant`), `AbilityGuard`/`@Can`/`@SkipAbility` for REST routes and GraphQL root fields (as an app-wide guard it passes the GraphQL endpoint when `GraphQLModule` runs `AbilityGuard` on its resolvers) (`createCan<Actions, Subjects>()` for a typed `@Can`), `@PermittedFields` for REST responses, `@AbilitySubject` field-level rules for GraphQL object types, and `CaslForbiddenFilter`/`mapCaslError` reporting CASL's `ForbiddenError` as a plain 403/`FORBIDDEN`. It re-exports `ForbiddenError` and `subject` (and the `AbilityBuilder`, `MongoAbility` and `RawRuleOf` types) from its own pinned `@casl/ability`.
  
  `@knead-js/graphql`: add a `mapError` option that maps errors thrown by resolver code, hooks, subscription filters and the WebSocket `context` factory to an `HttpException` before masking, `@UseFieldGuards()` field guards on object types (`FIELD_GUARDS` route-meta key, holding a frozen guard list), and a `GRAPHQL_ENDPOINT` route-meta entry on the endpoint exposing the module guards to app-wide HTTP guards.
- 871883c: `@knead-js/http`: `WsRegistry.register()` accepts `meta`, route-style metadata that guards read as `ctx.meta` on the upgrade request (merged over the GET route's meta when the endpoint shares its path).
  
  `@knead-js/casl`: add `canMeta()` and `skipAbilityMeta()`, the meta forms of `@Can()` and `@SkipAbility()`, so a global `AbilityGuard` can authorize WebSocket endpoints that have no GET route.

### Patch Changes

- Updated dependencies [1ee1275]
- Updated dependencies [f779f8a]
- Updated dependencies [5296955]
- Updated dependencies [f779f8a]
- Updated dependencies [7b77d69]
- Updated dependencies [5296955]
- Updated dependencies [82ce070]
- Updated dependencies [871883c]
  - @knead-js/graphql@0.2.0
  - @knead-js/core@0.2.0
  - @knead-js/http@0.2.0
