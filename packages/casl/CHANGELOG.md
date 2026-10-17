# @knead-js/casl

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
