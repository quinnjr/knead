# @knead-js/casl

[![npm](https://img.shields.io/npm/v/@knead-js/casl?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/casl)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

[CASL](https://casl.js.org) authorization for [Knead](https://github.com/quinnjr/knead): a
permission catalog, token grants checked against it, and guards for REST routes, GraphQL fields and
WebSocket endpoints. A request may do only what both its **user** and its **credential's grant**
allow.

**[Documentation](https://quinnjr.github.io/knead/packages/casl/)** · [Guide](https://quinnjr.github.io/knead/guide/authorization/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/casl @knead-js/core @knead-js/http
```

Requires Bun 1.4.3 or newer. `@knead-js/core` and `@knead-js/http` are peer dependencies;
`@knead-js/graphql` is an optional peer, needed only for the GraphQL features. The package depends
on its own pinned copy of `@casl/ability` (7.0.2), so you do not install CASL yourself.

## Quick start

```ts
import {
  AbilityGuard,
  AbilityService,
  asSubject,
  Can,
  CaslModule,
  definePermissions,
  type Identity,
} from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { Controller, type Ctx, Get, NotFoundException, Put, UseGuards } from '@knead-js/http';

interface User {
  id: string;
  admin: boolean;
}

/** What a credential can be granted: one area, three cumulative levels. */
export const permissions = definePermissions({
  posts: {
    description: 'Blog posts',
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: ['create', 'update'], subject: 'Post' }],
    },
  },
});

/** Your token store: each bearer token maps to its user and the grant it was issued with. */
export const tokens = new Map<string, Identity<User>>();

export const posts = new Map([['1', { id: '1', authorId: 'alice', title: 'Hello' }]]);

@Controller('/posts')
@UseGuards(AbilityGuard)
export class PostsController {
  readonly #abilities = inject(AbilityService);

  @Get('/')
  @Can('read', 'Post')
  list() {
    return [...posts.values()];
  }

  @Put('/:id')
  @Can('update', 'Post')
  async update(ctx: Ctx<{ params: { id: string } }>) {
    const post = posts.get(ctx.params.id);
    if (!post) throw new NotFoundException();
    // @Can() checked the subject type; this checks { authorId: user.id } against the record.
    await this.#abilities.authorize(ctx, 'update', asSubject('Post', post));
    return post;
  }
}

@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Who is calling, with which grant; undefined (or null) means unauthenticated (401).
      resolve: (ctx) => {
        const header = 'req' in ctx ? ctx.req.headers.get('authorization') : null;
        return header?.startsWith('Bearer ') ? tokens.get(header.slice(7)) : undefined;
      },
      // The most this user may ever do; the grant narrows it.
      defineUserAbility(user, { can }) {
        can('read', 'Post');
        can(['create', 'update'], 'Post', { authorId: user.id });
        if (user.admin) can('manage', 'all');
      },
    }),
  ],
  controllers: [PostsController],
})
export class AppModule {}
```

Without a token, `GET /posts` is a `401`. Alice with a `posts:read` token can list posts but gets a
`403` on `PUT /posts/1`, although she wrote it; with `posts:write` she can update it, while Bob with
`posts:write` cannot, because the user's condition does not match. An administrator holding a
`posts:read` token can only read.

## Features

- **User and grant intersected.** A token never widens what its user can do, and a user never gets
  more than the token grants.
- **Permission catalog.** Areas with ordered, cumulative levels, validated at startup and
  `describe()`-able for a token-issuing screen.
- **Untrusted grants parsed strictly.** Objects, scope strings or arrays; anything malformed allows
  nothing.
- **Fail-closed guard.** `AbilityGuard` denies a route without `@Can()`, and passes only on `=== true`.
- **Record checks.** `AbilityService.authorize()` evaluates conditions against the loaded record.
- **Field-level rules.** `@PermittedFields()` strips REST responses; `@AbilitySubject()` guards
  every field of a GraphQL type.
- **Safe token issuing.** `validateGrant()` refuses a grant that exceeds its user.
- **Configuration errors at startup.** Invalid catalogs and options throw `CaslConfigError` (a
  `KneadError`) at startup, never at request time. A route with `@PermittedFields()` but no
  `AbilityGuard` is not caught at startup: it responds `403` to every request.

## The catalog

`definePermissions(areas)` declares what a credential can be granted:

- `levels[0]` means no access and has no rules; every other level adds at least one rule.
- Levels are cumulative: `write` includes `read`'s rules.
- A rule has only `action`, `subject` and optionally `fields`. `manage` (any action) and `all` (any
  subject) are allowed; fields must not contain `*`.
- Conditions, `inverted` and `reason` are rejected: conditions belong in `defineUserAbility()`,
  where they are kept when the two sides are intersected.
- Area and level names match `/^[a-z][a-z0-9_-]{0,63}$/`.

The result is deep-frozen. `permissions.describe()` returns a JSON-safe list of areas and levels,
and `permissions.rulesFor(area, level)` a level's cumulative rules.

## Grants

`resolve(ctx)` returns `{ user, grant }`, or `undefined` (or `null`) for an unauthenticated
caller. The grant is untrusted input:

| Shape | Example |
| --- | --- |
| Object | `{ posts: 'write', billing: 'read' }` |
| Scope string | `'posts:write billing:read'` (at most `MAX_SCOPE_LENGTH`, 4096, characters) |
| Array | `['posts:write', 'billing:read']` |

- Areas left out are at `levels[0]`, no access.
- An unknown area or level, a repeated area, more entries than areas, a non-string level or any
  other shape makes the whole grant **malformed**, and it allows nothing. So does a missing or
  empty grant.
- A malformed or empty grant is still an authenticated identity with an empty ability, so every
  check is a `403`. Only a `resolve()` that returns no identity produces a `401`.
- The grant is parsed before `defineUserAbility()` runs: a malformed or missing grant skips it.
- Only own enumerable keys are read; `__proto__`, `constructor` and `prototype` are skipped.
- For a first-party session (your own app's sign-in), `fullGrant(permissions)` grants every area at
  its highest level. The user's own abilities still apply.

`parseGrant(input, permissions)` exposes the parser; it returns `null` for malformed input.

## REST

`CaslModule.forRoot()` is global. It provides `AbilityService` and `AbilityGuard` and registers
`CaslForbiddenFilter`, but does **not** make `AbilityGuard` a global guard: put it on controllers or
routes with `@UseGuards(AbilityGuard)`. It decides in this order:

1. `@SkipAbility()` passes without resolving an identity. When both apply, the more specific one
   wins: a method's `@Can()` overrides its controller's `@SkipAbility()` and the reverse. On the
   same method or controller, `@SkipAbility()` wins.
2. A route without `@Can()` is a `403` (fail closed), before `resolve()` runs.
3. No identity is a `401`.
4. Otherwise the route passes only if `ability.can(action, subject, field)` is `true`, else `403`.

Things to know:

- **`@Can()` checks the subject type**, not a record: a user who may update only their own posts
  passes `@Can('update', 'Post')`. Load the record and call `authorize(ctx, action,
  asSubject('Post', record))`, as the quick start does.
- **One ability per request.** The guard, `authorize()` and `forCtx()` share an ability cached on
  `ctx.state`, so `resolve()` and `defineUserAbility()` run at most once.
- **CASL's `ForbiddenError`** thrown by your code becomes a `403` through `CaslForbiddenFilter`,
  without CASL's message (it can describe your rules).
- **Import CASL from `@knead-js/casl`.** Use the re-exported `ForbiddenError`, `subject`,
  `AbilityBuilder`, `MongoAbility` and `RawRuleOf`: the filter and `mapCaslError` recognise
  `ForbiddenError` with `instanceof`, which matches only the package's own copy of CASL.
- **Typed `@Can()`.** `@Can()` accepts any strings; `createCan()` makes one the compiler checks:

```ts
type AppActions = 'manage' | 'read' | 'create' | 'update' | 'delete';
type AppSubjects = 'all' | 'Post' | 'User';

export const Can = createCan<AppActions, AppSubjects>();
```

### Stripping fields

`@PermittedFields(subjectType)` strips a handler's result to the fields the caller may `read`,
record by record, so conditions apply per record:

```ts
@Controller('/users')
@UseGuards(AbilityGuard)
export class UsersController {
  @Get('/')
  @Can('read', 'User')
  @PermittedFields('User')
  list() {
    // Each record is stripped to the fields the caller may read on it.
    return userRecords;
  }

  @Get('/page')
  @Can('read', 'User')
  @PermittedFields('User')
  page() {
    // Wrong: an envelope is stripped as one record, so `data` (not a User field) is dropped.
    return { data: userRecords, total: userRecords.length };
  }
}
```

- It strips the result or each element of an array, recursively, class instances included; an
  object with `toJSON()` is stripped after `toJSON()` runs.
- It does **not** look inside envelopes or nested records: return the records or the array
  directly, and strip nested records with `pickPermitted(ability, subjectType, record)`.
- It needs `AbilityGuard` to have run on the route; otherwise it responds `403`.

### The whole app

Register `AbilityGuard` as an `APP_GUARD` to require a decision on every route: any route without
`@Can()` or `@SkipAbility()` is then denied.

```ts
@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Global guards run before controller and route guards: resolve() authenticates by itself.
      resolve: (ctx) => ('req' in ctx ? sessionFrom(ctx.req) : undefined),
      defineUserAbility,
    }),
  ],
  controllers: [StatusController],
  providers: [FeedGateway, { provide: APP_GUARD, multi: true, useExisting: AbilityGuard }],
})
export class AppModule {}
```

- **`resolve()` must identify the caller itself**, from the request: global guards run before any
  route-level authentication guard could store something on `ctx.state`.
- **WebSocket endpoints** have no decorators. Declare their requirement when registering with
  `canMeta(action, subject)` or `skipAbilityMeta()`; an endpoint with neither is denied with `403`.
  An endpoint on the path of a GET route also gets that route's `@Can()`; its own `meta` wins.
- **The GraphQL endpoint** passes when `GraphQLModule.forRoot({ guards })` includes `AbilityGuard`
  (or a subclass), because every root field is then checked against its own `@Can()`. Otherwise it
  has no `@Can()` and is denied.

## Issuing tokens

Before issuing a token, check that the requested grant does not exceed its user:

```ts
@Injectable()
export class TokenIssuer {
  readonly #abilities = inject(AbilityService);

  /** Returns the parsed, frozen grant to store with the new token. */
  async grantFor(user: User, requested: unknown): Promise<Grant> {
    const result = await this.#abilities.validateGrant(user, requested);
    if (!result.ok) {
      // [{ reason: 'malformed' }] or
      // [{ reason: 'exceeds-user', area, level, action, subject, field? }, ...]
      throw new BadRequestException('The token cannot be granted more than you can do', {
        extensions: { problems: result.problems },
      });
    }
    return result.grant;
  }
}
```

Every action and subject pair of the requested levels must be something the user can do, and when a
catalog rule names `fields`, every one of those fields too (a `cannot` on a field counts, and so
does an unconditional `cannot` on the pair that comes after its `can` rules).
Conditions are **not** evaluated at issue time: a user who can do something only conditionally
passes, and the conditions are enforced on every request, against the record.

## GraphQL

Run `AbilityGuard` as a module guard of `GraphQLModule`, put the identity on the GraphQL context,
and add `mapCaslError`:

```ts
@Module({
  imports: [
    GraphQLModule.forRoot({
      // Fields of this object are on every resolver ctx.
      context: (http) => ({ identity: sessionFrom(http.req) }),
      // Every query, mutation and subscription root field needs @Can() or @SkipAbility().
      guards: [AbilityGuard],
      // A CASL ForbiddenError thrown by a resolver is FORBIDDEN, not a masked internal error.
      mapError: mapCaslError,
      subscriptions: {
        // Before each recheck: look the token up again, so a revoked one ends the subscription.
        refreshContext: ({ http }) => {
          const identity = sessionFrom(http.req);
          return identity ? { identity } : false;
        },
      },
    }),
    CaslModule.forRoot<User>({ permissions, defineUserAbility, resolve: identityOf }),
  ],
  providers: [UsersResolver],
})
export class AppModule {}
```

`resolve()` now also receives resolver contexts, where `identityOf` reads `ctx.identity`; the
[authorization guide](https://quinnjr.github.io/knead/guide/authorization/#graphql) shows it.

- **Root fields.** Each query, mutation and subscription field needs `@Can()` or `@SkipAbility()`;
  a field with neither is `FORBIDDEN`, and no identity is `UNAUTHENTICATED`. `@Public()` from
  `@knead-js/graphql` skips module guards, `AbilityGuard` included.
- **One ability per operation, not per HTTP request.** The ability is cached on the operation's own
  state and shared by its resolvers. An `AbilityGuard` that also runs on the `/graphql` HTTP request
  itself (for example as a REST `APP_GUARD`) does not build another one there: it passes when the
  GraphQL module defers authorization to it, and otherwise denies, in both cases without calling
  `resolve()` or `defineUserAbility()`.
- **Subscriptions.** A subscription root field's ability is rebuilt every time its guards run, so
  with `recheckGuards: true` a revoked or narrowed grant takes effect at the next event. Set
  `subscriptions.refreshContext` so the recheck sees a fresh identity.
- **`mapCaslError` is needed** for CASL's own errors: without it, a `ForbiddenError` thrown by a
  resolver is an unexpected error, masked in production.

### Field-level rules

`@AbilitySubject(subjectType)` on an `@ObjectType()` class makes every field of the type (plain
`@Field` and `@ResolveField`) require `read` on `subjectType`, for the parent record and that
field. Field rules name the GraphQL field names.

- **Put it on each concrete `@ObjectType`.** `@InterfaceType` classes are not wrapped. Subclasses
  inherit it, and a subclass's own `@AbilitySubject()` replaces the subject type.
- **Make deniable fields nullable.** A denied field is `null` with a `FORBIDDEN` error; for a
  non-null field graphql-js nulls the nearest nullable parent, possibly the whole `data`.
- **Anonymous callers.** A root field open to anyone (`@SkipAbility()` or `@Public()`) may return
  an `@AbilitySubject` type, but every such field then needs an identity: without one it is `null`
  with an `UNAUTHENTICATED` error.
- **Conditions are matched against the parent object** your resolver returned.

## Pitfalls

- **Lists.** `@Can('read', 'Post')` checks the type, not which records a list returns. Fetch only
  the records the caller may read, for example with `@casl/prisma`'s `accessibleBy()` (not a
  dependency: install it yourself and check it supports `@casl/ability` 7.0.2).
- **No action aliases.** CASL's `createAliasResolver` is not supported: an alias is not expanded
  when the user's rules and the grant are intersected. Use `manage` and `all`, or list actions.
- **String subjects.** A user rule whose subject is a class never matches a catalog subject by
  name; only a catalog rule with subject `all` keeps it. Use string subject types and `asSubject()`.
- **Untagged records.** A plain object literal's subject type is `Object`, which matches no `Post`
  rule. Tag records with `asSubject(type, record)`, which does not modify them.
- **Conditions on plain data.** Conditions are matched against the record's own data properties;
  write them against plain data, not getters, methods or computed values.

## Documentation

- [Package reference](https://quinnjr.github.io/knead/packages/casl/): every option and export.
- [Authorization guide](https://quinnjr.github.io/knead/guide/authorization/): catalogs, grants,
  REST, WebSockets and GraphQL step by step, including how the user and the grant combine.
- [GraphQL guide](https://quinnjr.github.io/knead/guide/graphql/): guards, field guards and
  subscriptions.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
