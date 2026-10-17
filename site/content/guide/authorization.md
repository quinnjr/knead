---
title: Authorization
description: Decide what each request may do with CASL abilities, narrowed by the grant of the credential the caller presents.
---

`@knead-js/casl` builds a [CASL](https://casl.js.org) ability for every request and checks it in
guards, in your handlers and on individual fields. The rule it enforces is simple: a request may do
only what both its **user** and its **credential's grant** allow.

- The user's own abilities come from your `defineUserAbility()` function, written with CASL's
  `AbilityBuilder`. They may use conditions (`{ authorId: user.id }`), field lists and `cannot`.
- The grant comes with the credential (a personal access token's scopes, a JWT claim). It names a
  level for each area of a permission catalog you define, and every rule outside it is removed.

A token never widens what its user can do, and a user never gets more than the token grants. An
administrator holding a read-only token can only read.

```bash
bun add @knead-js/casl
```

The package depends on its own pinned copy of `@casl/ability` (7.0.2), so you do not install CASL
yourself. `@knead-js/core` and `@knead-js/http` are peers, and `@knead-js/graphql` is an optional
peer needed only for the GraphQL features. The full API is on the
[reference page](/packages/casl/).

## Define a permission catalog

The catalog lists what a credential can be granted. It is made of **areas** (`posts`, `billing`),
and each area has ordered **levels**:

<<< casl/permissions.ts#catalog title="permissions.ts"

The rules of the catalog work as follows:

- `levels[0]` means no access. It must not have rules, and every other level must add at least one.
- Levels are cumulative. `posts:write` includes the rules of `posts:read`, and `posts:manage`
  includes both.
- A rule has only `action`, `subject` and optionally `fields`. Each is a string or a string array
  (`fields` must be an array). `manage` (any action) and `all` (any subject) are allowed. Fields
  must not contain `*`.
- Area and level names match `/^[a-z][a-z0-9_-]{0,63}$/`.
- Conditions, `inverted` and `reason` are rejected. Conditions belong to the user's own abilities,
  where they are kept when the two sides are intersected.

`definePermissions()` copies and validates its input immediately. Anything malformed (an unknown
rule key, a duplicate level, a level without rules, a rules key that is not a level, an empty
catalog) throws a `CaslConfigError` naming the problem, for example
`area "posts": level "read" must add at least one rule`. `CaslConfigError` is a `KneadError`, so
configuration mistakes stop the application at startup, never at request time.

The result is deep-frozen. Two methods expose it:

<<< casl/permissions.ts#describe

`describe()` returns the same frozen object on every call, so it is safe to send to clients, for
example to build a token-issuing screen.

## Write the user's abilities

`defineUserAbility(user, builder)` describes the most this user may ever do. The builder is a CASL
`AbilityBuilder`, so use `can` and `cannot` as in any CASL app:

<<< casl/users.ts#user title="users.ts"

Here every user may read posts, edit their own posts, read the `id` and `name` of any user and every
field of their own user record. An administrator may do anything, but only within the grant.

## Identify the caller and their grant

`resolve(ctx)` tells the module who is calling. It returns an `Identity`, `{ user, grant }`, or
`undefined` (or `null`) for an unauthenticated caller. It may be async. A typical implementation
looks the bearer token up in your token store:

<<< casl/users.ts#sessions title="users.ts"

The grant is untrusted input, and `parseGrant()` accepts three shapes:

| Shape | Example |
| --- | --- |
| Object | `{ posts: 'write', billing: 'read' }` |
| Scope string | `'posts:write billing:read'` (separated by spaces, at most `MAX_SCOPE_LENGTH`, 4096, characters) |
| Array | `['posts:write', 'billing:read']` |

Areas that the grant leaves out are at their `levels[0]`, no access. The whole grant is
**malformed**, and allows nothing, if it has an unknown area or level, names an area twice, has more
entries than the catalog has areas, has a non-string level, has an entry longer than 4096
characters or an entry without `area:` before its first colon, or is any other kind of value
(`undefined`, `null`, a number). An empty grant (`{}`, `''`, `[]`) is valid but also allows nothing.
Only own enumerable keys of an object are read, and `__proto__`, `constructor` and `prototype` are
skipped.

> [!IMPORTANT]
> A missing, malformed or empty grant is not an error the caller sees as such: the identity is
> still authenticated, but its ability is empty, so every check is a `403`. Only a `resolve()` that
> returns `undefined` or `null` produces a `401`.

For a first-party session, a user signed in to your own app rather than a third-party token, grant
everything the catalog has with `fullGrant()`. The user's own abilities still apply:

<<< casl/permissions.ts#full-grant

## Register the module

Import `CaslModule.forRoot()` once, in your root module:

<<< casl/app.module.ts#module title="app.module.ts"

| Option | Type | Description |
| --- | --- | --- |
| `permissions` | `Permissions` | The catalog returned by `definePermissions()`. Required. |
| `resolve` | `(ctx: AbilityCtx) => Identity<U> \| null \| undefined \| Promise<...>` | Who is calling, with which grant. Required. |
| `defineUserAbility` | `(user: U, builder: AbilityBuilder<MongoAbility>) => void \| Promise<void>` | The user's own abilities. Required. |

`forRoot()` validates its options when it is called and throws a `CaslConfigError` if `permissions`
did not come from `definePermissions()` or `resolve` or `defineUserAbility` is not a function. The
module is global. It provides `AbilityService`, `AbilityGuard` and the `CASL_OPTIONS` token, and
registers `CaslForbiddenFilter` as an app-wide exception filter. It does **not** register
`AbilityGuard` as a global guard: you choose where it runs.

`resolve()` receives an `AbilityCtx`, which is either a REST `Ctx` or a GraphQL resolver context.
Checking `'req' in ctx` tells them apart, as above.

## Protect routes with `@Can()`

Put `AbilityGuard` on a controller or route with `@UseGuards()`, and declare what each route needs
with `@Can(action, subject, field?)`:

<<< casl/posts.controller.ts#controller title="posts.controller.ts"

`AbilityGuard` decides in this order:

1. A route with `@SkipAbility()` passes without resolving an identity. Use it for public routes.
   When both `@SkipAbility()` and `@Can()` apply, the more specific one wins: `@SkipAbility()` on
   the controller and `@Can()` on a method checks the method's `@Can()`, and `@Can()` on the
   controller with `@SkipAbility()` on a method makes that method public. On the same method or
   controller, `@SkipAbility()` wins.
2. A route without `@Can()` is denied with a `403` (fail closed). This happens before `resolve()`
   runs, so an anonymous caller also gets a `403` there, not a `401`.
3. `resolve()` returning no identity is a `401` (`UnauthorizedException`).
4. Otherwise the route passes only if `ability.can(action, subject, field)` returns `true`, and is a
   `403` (`ForbiddenException`) otherwise.

`@Can()` may go on the controller class, on a method, or both; a method's `@Can()` replaces the
class's. Both errors are the standard problem responses:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json; charset=utf-8

{"type":"about:blank","title":"Forbidden","status":403,"instance":"/posts/1"}
```

A `401` has the same shape with `"title":"Unauthorized"` and `"status":401`.

### Typed `@Can()`

`@Can()` accepts any strings. To have the compiler check action and subject names, make your own
`Can` with `createCan()`. It writes the same route metadata, so `AbilityGuard` treats it exactly like
`@Can()`:

<<< casl/typed-can.ts#typed title="can.ts"

<<< casl/typed-can.ts#usage

## Check records with `AbilityService`

`@Can('update', 'Post')` checks the subject **type**: "may this caller update some post?". A user
whose rule is `can('update', 'Post', { authorId: user.id })` passes it, because some posts match.
To check the conditions against a particular record, load it and call
`AbilityService.authorize()`, as the `update` route above does:

<<< casl/posts.controller.ts#authorize

`authorize(ctx, action, subject, field?)` throws `ForbiddenException` (`403`) unless the ability
allows it, and `UnauthorizedException` (`401`) when there is no identity. `forCtx(ctx)` returns
the ability itself, for checks of your own.

The ability is built once per request and cached on `ctx.state`: the guard, `authorize()` and
`forCtx()` share one, so `resolve()` and `defineUserAbility()` run once. A build that throws is not
cached; the next call tries again.

### Tag records with `asSubject()`

CASL has to know a record's subject type to match it against rules. `asSubject(type, record)` tags a
plain object with its type and returns the same object. It does not modify the record (the tag is
kept in a `WeakMap`), so it works on frozen objects, and tagging an object again replaces its type.

Without a tag, CASL falls back to its own detection: the type set by CASL's `subject()` helper,
otherwise the constructor's `modelName` or `name`. A plain object literal is therefore of type
`Object`, which matches no `Post` rule. `subject()` is re-exported too, but unlike `asSubject()` it
defines a hidden property on the record and throws if the record was already cast to another type.

### Throw CASL's own `ForbiddenError`

Code that uses CASL's `ForbiddenError.from(ability).throwUnlessCan(...)` works as well:

<<< casl/posts.controller.ts#forbidden-error

`CaslForbiddenFilter`, registered by `forRoot()`, turns a CASL `ForbiddenError` into the same `403`
problem as above. CASL's message is not sent, because it can describe your rules. Import
`ForbiddenError` from `@knead-js/casl`, not from `@casl/ability`: the filter recognizes it with
`instanceof`, which matches only errors created by the package's own copy of CASL.

## Strip fields from responses

`@PermittedFields(subjectType)` filters a handler's result to the fields the caller may `read` on
`subjectType`, record by record, so conditions apply per record:

<<< casl/users.controller.ts#controller title="users.controller.ts"

With the abilities above and a full grant, Alice gets her own record in full and only `id` and
`name` of everyone else:

```json
[
  { "id": "alice", "name": "Alice", "email": "alice@example.com", "billingAddress": "1 Main St" },
  { "id": "bob", "name": "Bob" }
]
```

With a grant of only `users:read`, her own record also loses `billingAddress`, because that area
grants only `id`, `name` and `email`.

What it strips:

- The result itself when it is an object, or each element of an array, recursively.
- Every object, whatever its prototype: class instances are stripped too.
- An object with a `toJSON()` method is stripped after `toJSON()` runs.
- Values that are not records pass through unchanged: primitives, `null`, `undefined` (a `204`),
  `Response`, `Blob`, `ReadableStream`, `ArrayBuffer`, typed arrays and `Date`.
- A result that contains a cycle throws `PermittedFields: the result contains a cycle`, which is a
  `500`, rather than overflowing the stack.

> [!WARNING]
> `@PermittedFields()` does not look inside envelopes or nested records. `{ data: [...], total }`
> is stripped as one `User` record, so `data` and `total` are removed (they are not `User` fields)
> and the caller receives `{}`. Return the records or the array directly, and strip nested records
> yourself with `pickPermitted()`.

`@PermittedFields()` reads the ability that `AbilityGuard` cached for the request. Without one it
refuses to run the handler and responds `403` with the detail
`PermittedFields requires AbilityGuard`.

`pickPermitted(ability, subjectType, record)` does the same for one record by hand: it returns a new
object with the record's own enumerable string keys that the ability lets the caller `read`.

## Issue tokens safely with `validateGrant()`

Before you issue a token with a requested grant, check that the grant does not exceed its user:

<<< casl/token-issuer.ts#issuer title="token-issuer.ts"

`validateGrant(user, requested)` resolves to `{ ok: true, grant }`, with the parsed, frozen grant
to store, or `{ ok: false, problems }`. A problem is either `{ reason: 'malformed' }` or

```json
{ "reason": "exceeds-user", "area": "posts", "level": "manage", "action": "delete", "subject": "Post" }
```

for every action and subject pair of the granted levels that the user cannot do. With the abilities
above, a regular user asking for `posts:manage` gets exactly that problem, because they cannot
`delete` posts. When a catalog rule names `fields`, each field is checked too and the problem
carries a `field` property: a user with only `can('read', 'User', ['id', 'name'])` cannot be issued
`billing:read`, and the problem has `field: 'billingAddress'`. A `cannot` on a field also counts,
and so does an unconditional `cannot` on the pair (no conditions, no fields) that comes after its
`can` rules.

> [!NOTE]
> Conditions are not evaluated at issue time. A user who can do something only conditionally passes
> the check: with the abilities above, any user may be issued `billing:read`, because each user may
> read their own record's `billingAddress`. The conditions are enforced on every request, against
> the record.

## Apply `AbilityGuard` to the whole app

To require a decision on every route, register `AbilityGuard` as a global guard. Every route then
needs `@Can()` or `@SkipAbility()`, and any route you forget is denied:

<<< casl/global.module.ts#module title="app.module.ts"

<<< casl/global.module.ts#controller

> [!IMPORTANT]
> Global guards run before controller and route guards. With a global `AbilityGuard`, `resolve()`
> must identify the caller itself, from the request, rather than read something a route-level
> authentication guard stored on `ctx.state`.

### WebSocket endpoints

A global guard also runs on WebSocket upgrades. Endpoints registered with `WsRegistry` have no
decorators, so declare their requirement in the `meta` option with `canMeta()` or
`skipAbilityMeta()`, the metadata forms of `@Can()` and `@SkipAbility()`:

<<< casl/global.module.ts#gateway title="feed.gateway.ts"

The upgrade is then decided like a route: `101` when the ability allows it, `401` without an
identity, `403` when denied, and `403` for an endpoint registered with neither. An endpoint on the
path of a GET route also gets that route's metadata, `@Can()` included; its own `meta` wins. See
[WebSockets](/guide/websockets/) for the registry itself.

The GraphQL endpoint is handled for you: the global guard passes the `/graphql` request and its
subscription upgrades when `GraphQLModule.forRoot({ guards })` includes `AbilityGuard` (or a
subclass), because every root field is then checked against its own `@Can()`. Without that, the
endpoint has no `@Can()` and is denied.

## GraphQL

The same guard and decorators work on GraphQL root fields. Register `AbilityGuard` as a module guard
of `GraphQLModule`, put the identity on the GraphQL context, and add `mapCaslError`:

<<< casl/graphql.module.ts#module title="app.module.ts"

Declare the context field so that it is typed, including in `refreshContext`:

<<< casl/graphql.module.ts#context

`resolve()` now receives resolver contexts too. The fields of the object returned by `context` are
on every resolver context, so it reads `identity` there:

<<< casl/graphql.module.ts#resolve

How root fields are checked:

- `guards: [AbilityGuard]` runs on every query, mutation and subscription root field. Each needs
  `@Can()` or `@SkipAbility()`; a field with neither is `FORBIDDEN`, and no identity is
  `UNAUTHENTICATED`. `@Public()` from `@knead-js/graphql` skips module guards, `AbilityGuard`
  included.
- The ability is built once per operation and shared by all of its resolvers.
- `mapError: mapCaslError` reports a CASL `ForbiddenError` thrown by a resolver as `FORBIDDEN`,
  without CASL's message. Without it, the error is an unexpected one: with error masking on (the
  default outside development) the client sees only a masked internal error.

<<< casl/graphql.module.ts#resolver title="users.resolver.ts"

### Field-level rules with `@AbilitySubject()`

`@AbilitySubject(subjectType)` on an `@ObjectType()` class makes every field of the type, plain
`@Field` and `@ResolveField` alike, require `read` on `subjectType` for the parent record and that
field:

<<< casl/graphql.module.ts#type title="user.type.ts"

It adds `FieldAbilityGuard` as a field guard of the type. Field rules name the GraphQL field names.
A denied field is `null` with a `FORBIDDEN` error at its path, and the rest of the result is kept.
For the query `{ users { id email } }`, Alice with a `users:read` grant gets:

```json
{
  "data": {
    "users": [
      { "id": "alice", "email": "alice@example.com" },
      { "id": "bob", "email": null }
    ]
  },
  "errors": [
    {
      "message": "Forbidden",
      "locations": [{ "line": 1, "column": 14 }],
      "path": ["users", 1, "email"],
      "extensions": { "code": "FORBIDDEN" }
    }
  ]
}
```

Things to know about field rules:

- **Put it on each concrete `@ObjectType`.** `@InterfaceType` classes are not wrapped. A subclass
  inherits `@AbilitySubject()`, and a subclass's own `@AbilitySubject()` replaces the subject type.
  It combines with `@UseFieldGuards()`.
- **Anonymous callers.** A root field open to anyone (`@SkipAbility()` or `@Public()`) may return an
  `@AbilitySubject` type, but each of its fields needs an identity. Without one, every such field is
  `null` with an `UNAUTHENTICATED` error, as `featuredUser` above shows.
- **Make deniable fields nullable.** For a non-null field, graphql-js nulls the nearest nullable
  parent instead, possibly the whole `data`.
- **Conditions are matched against the parent object** your resolver returned, by its own data
  properties.

### Subscriptions

A subscription root field's ability is never cached: it is rebuilt every time its guards run. With
`recheckGuards: true` the guards run again before every event, so a narrowed or revoked grant takes
effect at the next event:

<<< casl/graphql.module.ts#subscription

`resolve()` sees the context of the subscription's connection, which is fixed when it connects.
For the recheck to see a change, the module above sets `subscriptions.refreshContext` to look the
token up again before each recheck; returning `false` there ends the subscription with `FORBIDDEN`.
See [GraphQL](/guide/graphql/) for subscriptions and their options.

## How the user and the grant combine

`AbilityService` intersects the user's rules with the rules of the grant's levels:

- Each positive user rule is replaced, at its own position, by its intersection with every grant
  rule. Actions and subjects must match by name; `manage` and `all` on either side match anything
  and keep the other side's names. Field lists are intersected, and the user's field patterns (CASL
  supports `*` there) are matched against the catalog's fields.
- The user's conditions are kept on every intersected rule.
- Each `cannot` rule of the user is kept unchanged at its position, so CASL's "later rules win"
  order is preserved.

The result never allows more than either side. This is why a `manage all` administrator with a
`posts:read` token can read posts and do nothing else.

## Pitfalls

- **No action aliases.** CASL's `createAliasResolver` is not supported: an alias is not expanded
  when the user's rules and the grant are intersected. Use `manage` and `all`, or list actions.
- **Class subjects.** A user rule whose subject is a class rather than a string never matches a
  catalog subject by name; only a catalog rule with subject `all` keeps it. Use string subject types
  and `asSubject()`.
- **Conditions on plain data.** Conditions are matched against the record's own data properties.
  Write them against plain data, not getters, methods or computed values.
- **Lists.** `@Can('read', 'Post')` checks the type, not which records a list returns. Fetch only
  the records the caller may read, for example with CASL's `@casl/prisma` package, which turns an
  ability into a Prisma `where` clause. It is not a dependency of `@knead-js/casl`: install it
  yourself, and check that it supports the `@casl/ability` version this package pins (7.0.2).
- **`@PermittedFields()` needs the guard.** It works only on routes where `AbilityGuard` ran.
- **Import CASL from `@knead-js/casl`.** Use the re-exported `ForbiddenError`, `subject`,
  `AbilityBuilder`, `MongoAbility` and `RawRuleOf`, so that your code and the package share one
  copy of CASL.
