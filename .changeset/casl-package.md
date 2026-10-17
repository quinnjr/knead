---
'@knead-js/casl': minor
'@knead-js/graphql': minor
---

Add `@knead-js/casl`: CASL authorization with a permission catalog (`definePermissions`), token grants narrowing each user's abilities (`validateGrant`, `fullGrant`), `AbilityGuard`/`@Can`/`@SkipAbility` for REST routes and GraphQL root fields, `@PermittedFields` for REST responses and `@AbilitySubject` field-level rules for GraphQL object types.

`@knead-js/graphql`: add a `mapError` option that maps errors thrown by resolver code to an `HttpException` before masking, and `@UseFieldGuards()` field guards on object types (`FIELD_GUARDS` route-meta key).
