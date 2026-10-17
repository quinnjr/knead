---
title: @knead-js/casl
description: CASL authorization for Knead with a permission catalog, token grants, guards for REST, WebSocket and GraphQL, and field-level rules.
---

```bash
bun add @knead-js/casl @knead-js/core @knead-js/http
# only for the GraphQL features:
bun add @knead-js/graphql graphql
```

`@casl/ability` is a dependency of the package, pinned exactly to 7.0.2; you do not install it.
`@knead-js/core` and `@knead-js/http` are peers, and `@knead-js/graphql` is an optional peer.

`@knead-js/casl` builds a [CASL](https://casl.js.org) ability per request from two sources: the
user's own abilities, written with CASL's `AbilityBuilder`, and the grant of the credential the
caller presents, which names a level per area of a permission catalog. A request may do only what
both allow. The package checks the result in guards (`AbilityGuard`, `@Can()`), in handlers
(`AbilityService`), on REST response fields (`@PermittedFields()`) and on GraphQL fields
(`@AbilitySubject()`). The [authorization guide](/guide/authorization/) walks through a complete
setup; this page lists every export.

## Module

### `CaslModule`

`CaslModule.forRoot<U>(options: CaslModuleOptions<U>): DynamicModule` registers the package. The
module is global. It provides and exports `CASL_OPTIONS`, `AbilityService` and `AbilityGuard`, and
registers `CaslForbiddenFilter` as an app-wide exception filter (`APP_FILTER`). It does not
register `AbilityGuard` as a global guard; opt in with
`{ provide: APP_GUARD, multi: true, useExisting: AbilityGuard }` or use
`@UseGuards(AbilityGuard)`.

`forRoot()` validates its options immediately and throws `CaslConfigError` when:

| Problem | Message |
| --- | --- |
| `options` is not an object | `CaslModule.forRoot() options must be an object` |
| `permissions` has no `areas` object or `rulesFor` function | `CaslModule.forRoot(): permissions must come from definePermissions()` |
| `resolve` is not a function | `CaslModule.forRoot(): resolve must be a function` |
| `defineUserAbility` is not a function | `CaslModule.forRoot(): defineUserAbility must be a function` |

There is no `forRootAsync()`.

### `CaslModuleOptions`

`interface CaslModuleOptions<U = any>`:

| Option | Type | Description |
| --- | --- | --- |
| `permissions` | `Permissions` | The catalog from `definePermissions()`. |
| `resolve` | `(ctx: AbilityCtx) => Identity<U> \| null \| undefined \| Promise<Identity<U> \| null \| undefined>` | Who is calling and with which grant. `undefined` or `null` means unauthenticated (`401`). Called at most once per request or GraphQL operation (see `AbilityService`). |
| `defineUserAbility` | `(user: U, builder: AbilityBuilder<MongoAbility>) => void \| Promise<void>` | The user's own abilities, before they are narrowed to the grant. Conditions, fields and `cannot` are allowed. |

All three are required and have no defaults.

### `CASL_OPTIONS`

`InjectionToken<CaslModuleOptions>` holding the options passed to `forRoot()`. Exported by the
module, so `inject(CASL_OPTIONS).permissions` gives any provider the catalog.

### `Identity`

`interface Identity<U = unknown> { user: U; grant: unknown }`: what `resolve()` returns. `grant` is
the raw credential grant (a token's scopes, a JWT claim). It is parsed with `parseGrant()`; a
missing or malformed grant allows nothing.

### `AbilityCtx`

`type AbilityCtx = Ctx | GraphQLLikeCtx`: what `resolve()`, `AbilityGuard` and `AbilityService`
accept, a REST request context or a GraphQL resolver context. `'req' in ctx` (or `'info' in ctx`)
tells them apart.

### `GraphQLLikeCtx`

The structural part of a `@knead-js/graphql` `ResolverCtx` that the package reads, declared here so
the package's types do not depend on the optional GraphQL peers:

| Property | Type |
| --- | --- |
| `state` | `Record<PropertyKey, unknown>` |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` |
| `info` | `{ fieldName: string; parentType: { name: string }; schema: { getSubscriptionType(): { name: string } \| null \| undefined } }` |

The other fields of a resolver context, including those your GraphQL `context` function returns,
are present at runtime but not in this type.

## Permission catalog

### `definePermissions()`

`definePermissions<const C extends Catalog>(areas: C): Permissions<C>` validates and copies a
catalog. Later changes to the input have no effect, and the stored copy is deep-frozen.

<<< casl/permissions.ts#catalog

Validation, each failure a `CaslConfigError` naming the area, level or rule:

- The catalog is an object with at least one area.
- Area and level names match `/^[a-z][a-z0-9_-]{0,63}$/`; levels are unique; `levels` is a
  non-empty array; `description`, if present, is a string.
- `rules` is an object whose keys are levels. `levels[0]` (no access) has no rules; every other
  level has a non-empty rule array.
- A rule has only the keys `action`, `subject` and `fields`. `action` and `subject` are a non-empty
  string or a non-empty array of non-empty strings. `fields`, if present, is a non-empty array of
  non-empty strings without `*`.

### `fullGrant()`

`fullGrant<C extends Catalog>(p: Permissions<C>): Record<keyof C & string, string>` maps every area
to its highest (last) level. Use it as the grant of a first-party session.

### `Permissions`

What `definePermissions()` returns:

| Member | Type | Description |
| --- | --- | --- |
| `areas` | `C` | The frozen copy of the catalog. |
| `describe()` | `() => PermissionCatalogJson` | JSON-safe, deep-frozen description; the same object on every call. |
| `rulesFor(area, level)` | `(area: keyof C & string, level: string) => RawRuleOf<MongoAbility>[]` | Cumulative rules of `level`: that level's and every lower level's, as fresh CASL raw rules. `[]` for `levels[0]`, an unknown area or an unknown level. |

### `PermissionCatalogJson`

`{ areas: { name: string; description?: string; levels: string[] }[] }`, in catalog order.
`description` is left out when the area has none.

### `Catalog`

`type Catalog = Record<string, AreaDefinition>`.

### `AreaDefinition`

`interface AreaDefinition<L extends string = string>`:

| Property | Type | Description |
| --- | --- | --- |
| `description` | `string` (optional) | Shown by `describe()`. |
| `levels` | `readonly [L, ...L[]]` | Ordered; `levels[0]` means no access. |
| `rules` | `Partial<Record<L, readonly CatalogRule[]>>` | The rules each level adds. |

### `CatalogRule`

`interface CatalogRule { action: string | readonly string[]; subject: string | readonly string[]; fields?: readonly string[] }`.
No conditions: they come from `defineUserAbility()`.

## Grants

### `parseGrant()`

`parseGrant(input: unknown, permissions: Permissions): Grant | null` parses an untrusted grant.

| Input | Parsing |
| --- | --- |
| Object | Own enumerable string keys are areas, values are levels. `__proto__`, `constructor` and `prototype` keys are skipped. A non-string value makes it malformed. |
| String | At most `MAX_SCOPE_LENGTH` characters, split on the space character (runs of spaces are fine; tabs and newlines are not separators); each entry is `area:level`, split at the first `:`. |
| Array | Each element is an `area:level` string of at most `MAX_SCOPE_LENGTH` characters. |

It returns `null` (malformed) for any other value (`undefined`, `null`, numbers), for an unknown
area or level, for an area named twice, for more entries than the catalog has areas, and for an
entry without a non-empty area before a colon. An empty input (`{}`, `''`, `[]`) returns an empty
grant, which is valid and allows nothing. The parser is linear in its input.

### `Grant`

`type Grant = Readonly<Record<string, string>>`: a validated area to level map. Areas that are
absent are at `levels[0]`. A parsed grant is frozen and has a `null` prototype.

### `MAX_SCOPE_LENGTH`

`4096`: the longest scope string, and the longest array entry, that `parseGrant()` accepts.

## `AbilityService`

Injectable, provided by `CaslModule`.

| Method | Description |
| --- | --- |
| `forCtx(ctx: AbilityCtx): Promise<AppAbility>` | The caller's ability: the user's rules intersected with the grant's (`intersectRules()`). Throws `UnauthorizedException` when `resolve()` returns `undefined` or `null`. A malformed grant gives an ability with no rules. |
| `authorize(ctx: AbilityCtx, action: string, subject: string \| object, field?: string): Promise<void>` | Throws `ForbiddenException` unless `ability.can(action, subject, field)` is `true` (and `UnauthorizedException` without an identity). `subject` is a type name or a record tagged with `asSubject()`. |
| `validateGrant(user: unknown, input: unknown): Promise<GrantValidation>` | Checks that a requested grant does not exceed `user`, before you issue a credential with it. |

**Caching.** `forCtx()` caches the ability on `ctx.state`, so a request (or a GraphQL operation)
calls `resolve()` and `defineUserAbility()` once, whoever asks first. The cache is bound to the
state object it was stored on: a spread copy of that state does not reuse it. A build that rejects
is not cached. A GraphQL subscription root field is never cached, so every guard run rebuilds its
ability.

**`validateGrant()`** parses the input with `parseGrant()` and, for every rule of every granted
level, checks each action and subject pair: the user needs some positive rule for it, conditions
not evaluated. When the catalog rule names `fields`, each field must be allowed instead (a
`cannot` on it wins). It resolves to `{ ok: true, grant }` or to `{ ok: false, problems }`.

<<< casl/token-issuer.ts#issuer

### `GrantValidation`

`type GrantValidation = { ok: true; grant: Grant } | { ok: false; problems: GrantProblem[] }`.

### `GrantProblem`

```text
{ reason: 'malformed' }
{ reason: 'exceeds-user', area: string, level: string, action: string, subject: string, field?: string }
```

`field` is set only when the catalog rule names fields and the user may not use this one. Each
distinct area, action, subject and field combination is reported once.

## Guards and decorators

### `AbilityGuard`

`class AbilityGuard implements Guard<AbilityCtx>`, provided by `CaslModule`. Usable as a route
guard, a global guard (`APP_GUARD`) and a `GraphQLModule` guard. `canActivate(ctx)` returns:

1. `true` when the route's metadata has `@SkipAbility()` (`ctx.meta[SKIP] === true`), without
   resolving an identity.
2. `true` on the GraphQL endpoint's HTTP routes (queries, mutations and subscription upgrades) when
   `GraphQLModule.forRoot({ guards })` includes `AbilityGuard`, an instance of it or a subclass, since
   every root field is then checked on its own.
3. `false` (`403`) when the route has no `@Can()` requirement (fail closed).
4. Otherwise the result of `ability.can(action, subject, field) === true`, after `forCtx()`, which
   throws `UnauthorizedException` (`401`, `UNAUTHENTICATED` on GraphQL) without an identity.

It can be subclassed; a subclass in the GraphQL `guards` counts for step 2.

### `@Can()`

`Can(action: string, subject: string, field?: string): ClassOrMethodDecorator` stores a
`CanRequirement` in route metadata under `CAN`. Works on controllers, routes and GraphQL root-field
resolver methods; a route's `@Can()` replaces its controller's. It checks the subject type; check a record's
conditions with `AbilityService.authorize()`.

### `createCan()`

`createCan<Actions extends string, Subjects extends string>(): (action: Actions, subject: Subjects, field?: string) => ClassOrMethodDecorator`
returns `Can` itself with narrower parameter types, so the compiler rejects unknown action and
subject names. It writes the same metadata as `@Can()`.

<<< casl/typed-can.ts#typed

### `@SkipAbility()`

`SkipAbility(): ClassOrMethodDecorator` marks a route as public for `AbilityGuard` (route metadata
`SKIP` set to `true`). It wins over `@Can()` when both apply.

### `canMeta()`

`canMeta(action: string, subject: string, field?: string): Readonly<Record<PropertyKey, unknown>>`
returns `{ [CAN]: requirement }`, the metadata `@Can()` writes, for places without decorators, such
as `WsRegistry.register(path, endpoint, { meta: canMeta('read', 'Post') })`.

### `skipAbilityMeta()`

`skipAbilityMeta(): Readonly<Record<PropertyKey, unknown>>` returns `{ [SKIP]: true }`, the metadata
form of `@SkipAbility()`.

<<< casl/global.module.ts#gateway

### `CanRequirement`

`interface CanRequirement { action: string; subject: string; field?: string }`: the value stored
under `CAN`. `field` is absent when not given.

### Metadata keys

| Key | Value | Description |
| --- | --- | --- |
| `CAN` | `Symbol.for('knead:casl:can')` | Route-metadata key holding a `CanRequirement`. |
| `SKIP` | `Symbol.for('knead:casl:skip')` | Route-metadata key that `@SkipAbility()` sets to `true`; `AbilityGuard` checks for exactly `true`. |

Both are created with `Symbol.for()`, so they are the same symbols across copies of the package.

## Field-level rules

### `@PermittedFields()`

`PermittedFields(subjectType: string)` is a method decorator for route handlers. Before calling the
handler it takes the ability `AbilityGuard` cached for the request; without one it throws
`ForbiddenException('PermittedFields requires AbilityGuard')` and the handler does not run. It then
strips the result to the fields the caller may `read` on `subjectType`, per record:

| Result | Treatment |
| --- | --- |
| Primitive, `null`, `undefined` | Unchanged. |
| `Response`, `Blob`, `ReadableStream`, `ArrayBuffer`, typed array or `DataView`, `Date` | Unchanged. |
| Array | Each element stripped, recursively. |
| Object with a `toJSON()` method | `toJSON()` is called and its result stripped (its own `toJSON()` is not called again). A `toJSON()` returning the object itself strips the object. |
| Any other object, class instances included | `pickPermitted()`. |
| A result containing a cycle | Throws `PermittedFields: the result contains a cycle` (a `500`). |

Objects nested inside a record's properties, and records inside envelopes such as
`{ data: [...], total }`, are not looked into: the envelope is stripped as one record.

### `pickPermitted()`

`pickPermitted<T extends object>(ability: AppAbility, subjectType: string, record: T): Partial<T>`
returns a new plain object with the own enumerable string keys of `record` for which
`ability.can('read', record, key)` is `true`, the record tagged as `subjectType`. Keys are defined
rather than assigned, so a `__proto__` key in the record stays an ordinary key.

## GraphQL

### `@AbilitySubject()`

`AbilitySubject(subjectType: string)` is a class decorator for `@ObjectType()` classes. Every field
of the type, plain `@Field` and `@ResolveField`, then requires `read` on `subjectType` for the
parent record and the field, by its GraphQL name, through `FieldAbilityGuard`. It stores
`SUBJECT` in the class's route metadata and adds `FieldAbilityGuard` to its field guards once.

- Put it on each concrete `@ObjectType`; `@InterfaceType` classes are not wrapped.
- It combines with `@UseFieldGuards()`.
- Subclasses inherit it; a subclass's own `@AbilitySubject()` replaces the subject type without
  changing the parent class's metadata.

<<< casl/graphql.module.ts#type

### `FieldAbilityGuard`

The field guard `@AbilitySubject()` adds. `canActivate(ctx)` is `false` (`FORBIDDEN`) when the
subject type is missing or the parent is not an object, throws `UnauthorizedException`
(`UNAUTHENTICATED`) without an identity, and is otherwise
`ability.can('read', asSubject(subjectType, parent), ctx.info.fieldName) === true`. You do not
register it yourself.

### `SUBJECT`

`Symbol.for('knead:casl:subject')`: the route-metadata key holding an `@AbilitySubject()` type's
subject type.

### `mapCaslError()`

`mapCaslError(error: unknown): HttpException | undefined` is meant for
`GraphQLModule.forRoot({ mapError: mapCaslError })`. A CASL `ForbiddenError` becomes a
`ForbiddenException` without detail (`FORBIDDEN`, CASL's message not sent); anything else returns
`undefined` and is left as it is.

## Abilities

### `AppAbility`

`type AppAbility = MongoAbility`: the ability type the package builds.

### `createAppAbility()`

`createAppAbility(rules: RawRuleOf<MongoAbility>[]): AppAbility` creates a CASL `MongoAbility`
whose subject type detection first looks for an `asSubject()` tag, then falls back to CASL's own
detection. Use it when you build abilities yourself, for example in tests.

### `asSubject()`

`asSubject<T extends object>(type: string, record: T): T` records that `record` is of subject type
`type` and returns `record`. The tag lives in a `WeakMap`: the record is not modified (frozen
records work), and tagging it again replaces the type. Only abilities from `createAppAbility()`
(which includes every ability `AbilityService` builds) read the tag.

### `grantRules()`

`grantRules(grant: Grant, permissions: Permissions): RawRuleOf<MongoAbility>[]` concatenates
`permissions.rulesFor(area, level)` for every area of the grant.

### `intersectRules()`

`intersectRules(userRules: RawRuleOf<MongoAbility>[], grantRules: RawRuleOf<MongoAbility>[]): RawRuleOf<MongoAbility>[]`
returns rules allowed by both sides. User rules are walked in order:

- An inverted (`cannot`) user rule is kept unchanged, at its position.
- A positive user rule is replaced, at its position, by its intersection with each grant rule in
  grant order. Actions intersect by name, with `manage` on either side matching anything and keeping
  the other side's names; subjects likewise with `all`. A user subject that is not a string (a
  class) matches only a grant subject of `all`. Fields: no field list on one side keeps the other's;
  otherwise the grant's fields that match the user's field patterns. Empty intersections are
  dropped. The user's conditions are kept.

The result never allows more than either side. CASL action aliases (`createAliasResolver`) are not
expanded.

## Errors and filters

### `CaslConfigError`

`class CaslConfigError extends KneadError`: invalid configuration, thrown by `definePermissions()`
and `CaslModule.forRoot()`, never per request.

### `CaslForbiddenFilter`

An exception filter for CASL's `ForbiddenError`, registered app-wide by `forRoot()`. It responds
with the `ForbiddenException` problem, without CASL's message:

```json
{ "type": "about:blank", "title": "Forbidden", "status": 403, "instance": "/posts/1/publish" }
```

The `Content-Type` is `application/problem+json; charset=utf-8`. It matches with `instanceof`, so
only errors created by the package's copy of CASL; import `ForbiddenError` from `@knead-js/casl`.

## Re-exports from `@casl/ability`

The package re-exports these names from its own pinned copy of `@casl/ability`. Import them from
`@knead-js/casl` so that your code uses the same copy as the package: `CaslForbiddenFilter` and
`mapCaslError` recognize a `ForbiddenError` with `instanceof`, which only matches errors created by
that copy, and your `defineUserAbility()` types match the builder the package passes in.

| Name | Kind | Use |
| --- | --- | --- |
| `ForbiddenError` | class | `ForbiddenError.from(ability).throwUnlessCan(action, subject)`; mapped to `403` and `FORBIDDEN`. |
| `subject` | function | CASL's `subject(type, object)`: tags an object by defining a hidden `__caslSubjectType__` property, and throws if the object was already cast to another type. `asSubject()` does the same without modifying the object. |
| `AbilityBuilder` | type | The type of `defineUserAbility()`'s second argument, `AbilityBuilder<MongoAbility>`. |
| `MongoAbility` | type | CASL's ability type; `AppAbility` is an alias. |
| `RawRuleOf` | type | `RawRuleOf<MongoAbility>` is the raw rule type of `rulesFor()`, `grantRules()` and `intersectRules()`. |

`AbilityBuilder`, `MongoAbility` and `RawRuleOf` are re-exported as types only (`export type`), so
they cannot be used as values; `AbilityService` constructs the builder it passes to
`defineUserAbility()`.
