---
'@knead-js/graphql': patch
---

GraphQL execution hardening:

- `@ObjectType()` subclasses of a `@Resolver(() => T)` type now inherit its `@ResolveField()` methods with their guards, `authorize` and `validate`, instead of serving the raw inherited property. `@ResolveField()` on an `@InterfaceType()` (or `@InputType()`) target is a `SchemaBuildError`.
- `@UseFieldGuards()` on an `@InterfaceType()` or `@InputType()`, where it never ran, is a `SchemaBuildError`.
- A subscription field executed outside a subscription (for example a subscription document passed to `GraphQLRuntime.executor.execute`) is `BAD_USER_INPUT` and no longer calls the method without its guards.
- Computed subscription topics are deduplicated, and more than 100 distinct topics is `BAD_USER_INPUT`.
- A subscription `filter` sees the context as last replaced by `subscriptions.refreshContext`, not the subscribe-time one.
- `ctx.loader(Cls)` keeps one DataLoader per module, so modules that provide the same loader class each batch through their own provider.
- Under `defaultDeny`, an `authorize` guard counts as the field's own guard.
