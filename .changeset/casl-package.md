---
'@knead-js/casl': minor
'@knead-js/graphql': minor
---

Add `@knead-js/casl`: CASL authorization with a permission catalog (`definePermissions`), token grants narrowing each user's abilities (`validateGrant`, which also checks the fields a grant names and reports them as `GrantProblem.field`, and `fullGrant`), `AbilityGuard`/`@Can`/`@SkipAbility` for REST routes and GraphQL root fields (`createCan<Actions, Subjects>()` for a typed `@Can`), `@PermittedFields` for REST responses, `@AbilitySubject` field-level rules for GraphQL object types, and `CaslForbiddenFilter`/`mapCaslError` reporting CASL's `ForbiddenError` as a plain 403/`FORBIDDEN`. It re-exports `ForbiddenError` and `subject` (and the `AbilityBuilder`, `MongoAbility` and `RawRuleOf` types) from its own pinned `@casl/ability`.

`@knead-js/graphql`: add a `mapError` option that maps errors thrown by resolver code, hooks, subscription filters and the WebSocket `context` factory to an `HttpException` before masking, and `@UseFieldGuards()` field guards on object types (`FIELD_GUARDS` route-meta key, holding a frozen guard list).
