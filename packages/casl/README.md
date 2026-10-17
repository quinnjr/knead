# @knead-js/casl

[CASL](https://casl.js.org) authorization for Knead: a permission catalog of areas and levels, token
grants checked against it, `AbilityGuard` and `@Can()` for REST routes and GraphQL root fields,
`@AbilitySubject()` for field-level GraphQL rules, and `@PermittedFields()` for REST responses.

A request may do only what both its **user** and its **credential's grant** allow. The user's own
abilities come from your `defineUserAbility()`, written with CASL's `AbilityBuilder` (conditions,
fields and `cannot` included). The grant names a level per catalog area, like the scopes of a
personal access token, and every rule outside it is removed. A token never widens what its user can
do, and a user never gets more than the token grants.

```bash
pnpm add @knead-js/casl
```

`@casl/ability` (pinned exactly) is a dependency. `@knead-js/core` and `@knead-js/http` are peers;
`@knead-js/graphql` is an optional peer, needed only for the GraphQL features.

## Quick start

```ts
import { AbilityGuard, Can, CaslModule, definePermissions } from '@knead-js/casl';
import { Module } from '@knead-js/core';
import { Controller, type Ctx, Get, type Guard, Put, UseGuards } from '@knead-js/http';

interface User {
  id: string;
  admin: boolean;
}

interface Session {
  user: User;
  grant: unknown; // the credential's grant, e.g. a token's scopes
}

declare module '@knead-js/http' {
  interface CtxState {
    session?: Session;
  }
}

// Your authentication: it looks up the caller's session.
declare function sessionFrom(req: Request): Session | undefined;

/** Stores the caller's session on ctx.state for AbilityGuard. */
class AuthGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    ctx.state.session = sessionFrom(ctx.req);
    return true;
  }
}

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

@Controller('/posts')
@UseGuards(AuthGuard, AbilityGuard)
class PostsController {
  @Get('/') @Can('read', 'Post') list() {
    return [];
  }

  @Put('/:id') @Can('update', 'Post') update(ctx: Ctx<{ params: { id: string } }>) {
    return { id: ctx.params.id };
  }
}

@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Who is calling, with which grant; undefined (or null) means unauthenticated (401).
      resolve: (ctx) => {
        const session = (ctx as Ctx).state.session;
        return session && { user: session.user, grant: session.grant };
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

`CaslModule.forRoot()` is global and provides `AbilityService` and `AbilityGuard`. It validates its
options at startup (a `CaslConfigError`, a `KneadError`, names the problem); nothing about the
configuration fails at request time.

### Typed `@Can`

`@Can()` accepts any strings. To have the compiler check the action and subject names, make your
own `Can` with `createCan()` (it writes the same route meta, so `AbilityGuard` treats it alike):

```ts
import { createCan } from '@knead-js/casl';

type AppActions = 'manage' | 'read' | 'create' | 'update' | 'delete';
type AppSubjects = 'all' | 'Post' | 'User';

export const Can = createCan<AppActions, AppSubjects>();
// @Can('read', 'Post') compiles; @Can('read', 'Pots') does not.
```

### CASL exports

`@knead-js/casl` re-exports `ForbiddenError` and `subject` from `@casl/ability`, and the
`AbilityBuilder`, `MongoAbility` and `RawRuleOf` types. Import them from `@knead-js/casl` rather
than from `@casl/ability`: the package pins its own copy of CASL, and `CaslForbiddenFilter` and
`mapCaslError` recognise a `ForbiddenError` with `instanceof`, which only matches errors created
by that same copy.

## The catalog

`definePermissions(areas)` declares what a credential can be granted. Each area has ordered
`levels`; `levels[0]` means no access and has no rules, and every other level adds at least one rule.
Levels are cumulative: `write` above includes `read`'s rules. A rule has only `action`, `subject`
and optionally `fields` (strings or string arrays, `manage` and `all` allowed, no `*` in fields).
Conditions do not belong in the catalog: they come from `defineUserAbility()` and are kept when the
two are intersected.

Area and level names match `/^[a-z][a-z0-9_-]{0,63}$/`. Anything malformed (an unknown rule key, a
duplicate level, a level without rules, a rules key that is not a level) throws `CaslConfigError`
when `definePermissions()` runs.

The result is frozen. `permissions.describe()` returns a JSON-safe `{ areas: [{ name, description,
levels }] }`, for example to build a token-issuing screen, and `permissions.rulesFor(area, level)`
returns a level's cumulative rules as CASL raw rules.

## Grants

`resolve(ctx)` returns `{ user, grant }`. The grant is untrusted input (a token claim, a PAT's
scopes) and may be:

- an object: `{ posts: 'write', billing: 'read' }`;
- a scope string: `'posts:write billing:read'` (space separated, at most `MAX_SCOPE_LENGTH`, 4096,
  characters);
- an array: `['posts:write', 'billing:read']`.

Areas left out are at `levels[0]`. An unknown area or level, a repeated area, more entries than
areas, a non-string level or any other shape makes the whole grant malformed, and a malformed or
missing (`undefined`) grant allows **nothing**; so does an empty one. Only own enumerable keys are
read and `__proto__`, `constructor` and `prototype` are skipped. `parseGrant(input, permissions)`
exposes the parser (it returns `null` for malformed input).

For a first-party session (a user signed in to your own app, not a third-party token) grant
everything the catalog has with `fullGrant(permissions)`, which maps each area to its highest level.
The user's own abilities still apply.

## Issuing tokens: `validateGrant`

Before issuing a token, check that its requested grant does not exceed the user:

```ts
import { AbilityService } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { BadRequestException } from '@knead-js/http';

interface User {
  id: string;
}

export class TokenIssuer {
  readonly #abilities = inject(AbilityService);

  /** Returns the parsed, frozen grant to store with the new token. */
  async grantFor(user: User, requested: unknown) {
    const result = await this.#abilities.validateGrant(user, requested);
    if (!result.ok) {
      // [{ reason: 'malformed' }] or
      // [{ reason: 'exceeds-user', area, level, action, subject, field? }, ...]
      throw new BadRequestException('The token cannot be granted more than you can do');
    }
    return result.grant;
  }
}
```

`validateGrant` checks coverage at issue time: every action/subject pair the grant's rules name
must be something the user can do at least conditionally, and when a rule names `fields`, every one
of those fields too. A user with `can('read', 'User', ['id', 'name'])` cannot be issued a level
whose rule is `{ action: 'read', subject: 'User', fields: ['billingAddress'] }`: the problem names
the field (`field: 'billingAddress'`). A user with an unrestricted `can('read', 'User')` can.
Conditions are not evaluated then; they are enforced on every request, against the record.

## REST

- **`AbilityGuard`** passes a route only when the caller's ability allows its `@Can(action, subject,
  field?)` (on the method or the class). A route guarded by it without `@Can()` is denied, and no
  identity is a `401` (`UnauthorizedException`), a denial a `403`. Like every Knead guard, it passes
  only on `=== true`.
- **`@SkipAbility()`** makes `AbilityGuard` pass without resolving an identity: use it for public
  routes. It wins over `@Can()` when both apply (for example `@SkipAbility()` on the controller and
  `@Can()` on a method): the route passes and nothing is checked.
- **Not global by default.** Put it on controllers or routes with `@UseGuards(AbilityGuard)`, or opt
  in for the whole app (every route then needs `@Can()` or `@SkipAbility()`):

  ```ts
  import { AbilityGuard } from '@knead-js/casl';
  import { Module } from '@knead-js/core';
  import { APP_GUARD } from '@knead-js/http';

  @Module({ providers: [{ provide: APP_GUARD, multi: true, useExisting: AbilityGuard }] })
  export class AppModule {}
  ```

  Global guards run before route guards, so `resolve()` must then identify the caller itself rather
  than read what a route-level auth guard stored. A global guard also runs on WebSocket upgrades and
  on the `/graphql` request itself, which have no `@Can()` and are therefore denied: in an app with
  `@knead-js/graphql` or WebSocket endpoints, use `@UseGuards(AbilityGuard)` on the controllers
  instead, and `guards: [AbilityGuard]` for GraphQL.
- **`AbilityService`** builds the caller's ability once per request (cached on `ctx.state`):
  `forCtx(ctx)` returns it (or throws `UnauthorizedException`), and `authorize(ctx, action, subject,
  field?)` throws `ForbiddenException` unless it allows the action. `@Can()` checks the subject type;
  check conditions against the record itself:

  ```ts
  import { AbilityGuard, AbilityService, asSubject, Can } from '@knead-js/casl';
  import { inject } from '@knead-js/core';
  import { Controller, type Ctx, NotFoundException, Put, UseGuards } from '@knead-js/http';

  interface Post {
    id: string;
    authorId: string;
  }

  declare const posts: Map<string, Post>; // your data access

  @Controller('/posts')
  @UseGuards(AbilityGuard)
  export class PostsController {
    readonly #abilities = inject(AbilityService);

    @Put('/:id') @Can('update', 'Post')
    async update(ctx: Ctx<{ params: { id: string } }>) {
      const post = posts.get(ctx.params.id);
      if (!post) throw new NotFoundException();
      // Checks the user's conditions, such as { authorId: user.id }, against this post.
      await this.#abilities.authorize(ctx, 'update', asSubject('Post', post));
      return post;
    }
  }
  ```

  `asSubject(type, record)` tags a plain record with its CASL subject type without modifying it.
- **CASL errors.** A CASL `ForbiddenError` thrown by your code is turned into a `403` problem by
  `CaslForbiddenFilter`, which `forRoot()` registers. Its message is not sent. Import
  `ForbiddenError` from `@knead-js/casl` (see [CASL exports](#casl-exports)):

  ```ts
  import { type AppAbility, asSubject, ForbiddenError } from '@knead-js/casl';

  export function assertCanPublish(ability: AppAbility, post: { authorId: string }): void {
    ForbiddenError.from(ability).throwUnlessCan('publish', asSubject('Post', post));
  }
  ```
- **`@PermittedFields(subjectType)`** strips the handler's result down to the fields the caller may
  `read` on `subjectType` (it needs `AbilityGuard` to have run, `403` otherwise). It strips the
  result itself, or each element of an array (recursively); class instances are stripped too, and an
  object with `toJSON()` is stripped after `toJSON()` runs. It does **not** look inside envelopes:
  `{ data: [...], total }` is stripped as one record, so return the records or the array directly.
  `pickPermitted(ability, subjectType, record)` does the same for one record by hand.

## GraphQL

```ts
import {
  AbilityGuard,
  CaslModule,
  definePermissions,
  type Identity,
  mapCaslError,
} from '@knead-js/casl';
import { Module } from '@knead-js/core';
import { GraphQLModule } from '@knead-js/graphql';
import type { Ctx } from '@knead-js/http';

interface User {
  id: string;
}

// Your authentication: the caller's identity and grant, or undefined.
declare function sessionFrom(req: Request): Identity<User> | undefined;

const permissions = definePermissions({
  posts: { levels: ['none', 'read'], rules: { read: [{ action: 'read', subject: 'Post' }] } },
});

@Module({
  imports: [
    GraphQLModule.forRoot({
      // Fields of the context object are on every resolver ctx.
      context: (http) => ({ session: sessionFrom(http.req) }),
      guards: [AbilityGuard],
      mapError: mapCaslError,
    }),
    CaslModule.forRoot<User>({
      permissions,
      defineUserAbility(_user, { can }) {
        can('read', 'Post');
      },
      resolve: (ctx) =>
        'info' in ctx
          ? (ctx as unknown as { session?: Identity<User> }).session
          : sessionFrom((ctx as Ctx).req),
    }),
  ],
})
export class AppModule {}
```

- **`guards: [AbilityGuard]`** runs it on every query, mutation and subscription root field. Each
  needs `@Can()` or `@SkipAbility()`; a field with neither is `FORBIDDEN`, no identity is
  `UNAUTHENTICATED`. `@knead-js/graphql`'s `@Public()` skips module guards, `AbilityGuard`
  included. The ability is built once per operation; a subscription root field's ability is
  rebuilt for every check, so with `recheckGuards: true` a revoked or narrowed grant takes effect at
  the next event.
- **One ability per operation, not per HTTP request.** The GraphQL ability is cached on the
  operation's own state. An `AbilityGuard` that also runs on the `/graphql` HTTP request itself
  (for example as a REST `APP_GUARD`) builds a second one there, calling `resolve()` and
  `defineUserAbility()` again.
- **`mapError: mapCaslError`** is needed for CASL's own errors: it reports a `ForbiddenError` thrown
  by a resolver as `FORBIDDEN` (without CASL's message, as over REST) instead of a masked internal
  error.
- **`@AbilitySubject(subjectType)`** on an `@ObjectType()` class makes every field of the type (plain
  `@Field` and `@ResolveField`) require `read` on `subjectType`, for the parent record and that
  field, through `@knead-js/graphql` field guards (`FieldAbilityGuard`). Field rules therefore name
  the GraphQL field names (which are also the JSON names). Put it on each concrete `@ObjectType`
  class: `@InterfaceType` classes are not wrapped. It combines with `@UseFieldGuards()` and is
  inherited by subclasses; a subclass's own `@AbilitySubject()` replaces the subject type.
- **Anonymous callers.** A root field open to anonymous callers (`@SkipAbility()` or `@Public()`)
  may still return an `@AbilitySubject` type, but each of its fields then needs an identity: with
  none, every such field is `null` with an `UNAUTHENTICATED` error.
- **Non-null fields.** A denied field is `null` with a `FORBIDDEN` error. For a non-null field
  graphql-js nulls the nearest nullable parent instead (possibly the whole `data`), so make fields
  that may be denied nullable.

## Listing what the caller may see

`AbilityGuard` checks one subject type; a list endpoint should also fetch only the records the
caller may read. With Prisma, `@casl/prisma` turns the ability into a `where` clause:

```ts
import { accessibleBy } from '@casl/prisma';
import { AbilityGuard, AbilityService, Can } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Get, UseGuards } from '@knead-js/http';
import { PrismaClient } from '@prisma/client';

@Controller('/posts')
@UseGuards(AbilityGuard)
export class PostsController {
  readonly #abilities = inject(AbilityService);
  readonly #prisma = new PrismaClient();

  @Get('/') @Can('read', 'Post')
  async list(ctx: Ctx) {
    return this.#prisma.post.findMany({
      where: accessibleBy(await this.#abilities.forCtx(ctx)).Post,
    });
  }
}
```

`@casl/prisma` and Prisma are not dependencies of this package; install them yourself, and keep the conditions in
`defineUserAbility()` to what both CASL's matcher and Prisma understand.

## Limitations

- **No action aliases.** CASL's `createAliasResolver` is not supported: an alias is not expanded when
  the user's rules and the grant are intersected. `manage` (any action) and `all` (any subject) are
  supported.
- **Top-level field stripping only.** `@PermittedFields()` strips the returned records, not records
  nested in envelopes or in other records' properties.
- **Conditions on plain data.** Conditions are matched against the record's own data properties
  (`{ authorId: user.id }`); write them against plain data, not getters, methods or computed values.
  On GraphQL the record is the parent object the resolver returned.
