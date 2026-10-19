---
title: GraphQL
description: Build a code-first GraphQL API from decorated classes, with resolvers that use dependency injection, subscriptions over WebSocket and SSE, and production-safe limits.
---

`@knead-js/graphql` builds a GraphQL schema from TC39-decorated classes and serves it with the
[Leaven](https://github.com/quinnjr/leaven) engine. Types are classes, resolvers are ordinary
providers that use `inject()`, and a GraphQL field type that disagrees with its TypeScript type is a
compile error. The endpoint is an ordinary `@knead-js/http` route, so CORS, rate limiting, security
headers and global guards apply to it unchanged.

This page builds a small blog API step by step. Every option and export is listed in the
[package reference](/packages/graphql/).

## Install

```bash
bun add @knead-js/core @knead-js/http @knead-js/graphql graphql
```

`@knead-js/core`, `@knead-js/http` and `graphql` (16.x) are peer dependencies.

## Register the module

`GraphQLModule` is a global module. Import it once, in the root module, next to the feature modules
that hold your resolvers.

### Static options

`GraphQLModule.forRoot(options)` takes the options directly:

<<< graphql/sync-module.ts#sync title="app.module.ts"

`path` defaults to `/graphql`. It is the URL of both the HTTP endpoint and the WebSocket endpoint
for subscriptions, and it must be exact: a path with `:` or `*` is an `HttpConfigError`.

### Options from providers

When the options need a provider (a session service, configuration), use
`GraphQLModule.forRootAsync()`. `useFactory` runs in GraphQLModule's injection context, so it can
call `inject()` for anything that `imports` exports. `path` stays a static option, because the HTTP
routes are compiled from decorators before the factory runs.

<<< graphql/app.module.ts#app-module title="app.module.ts"

Start the application as usual:

<<< graphql/main.ts title="main.ts"

### What happens at bootstrap

When the application is created, the module:

- finds every class provider decorated with `@Resolver()`, in every module (a resolver must be
  listed in some module's `providers`);
- builds and validates the schema. A problem is a `SchemaBuildError` whose message names the class
  and field, for example `Post.author: type thunk returned undefined — is Author imported?`. A
  schema needs at least one `@Query()`;
- writes the sorted SDL to `schema.graphql` when the application is in development (see
  [the schema file](#the-schema-file));
- registers the subscription endpoint when the schema has a `@Subscription()` field.

It also provides three exported, injectable values: `PUBSUB` (the event engine), `GraphQLRuntime`
(the schema and executor) and `GraphQLSubscriptions` (revokes subscription sockets).

> [!NOTE]
> Several defaults depend on whether the application is in development: the `development` option
> of `KneadFactory.create(root, { development })` (the `HTTP_DEVELOPMENT` token), which defaults to
> `process.env.NODE_ENV === 'development'`. In development, errors are unmasked, introspection and
> the playground are on, and the schema file is written. Everywhere else they are off.

## Define types

Types are classes. A class decorator names the GraphQL type (the class name by default), and
`@Field()` exposes a property. Properties without `@Field()` stay private to the server.

### Object types and fields

<<< graphql/blog.types.ts#object-types title="blog.types.ts"

`@Field(() => Type, options)` takes a thunk that returns the field's type, and these options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nullable` | `boolean \| 'items' \| 'list' \| 'both'` | `false` | Which part of the type may be null. See [nullability and lists](#nullability-and-lists). |
| `description` | `string` | none | Description in the schema. |
| `deprecationReason` | `string` | none | Marks the field `@deprecated(reason: ...)`. |
| `defaultValue` | the field's type | none | Default for input type fields and `@ArgsType()` arguments. |
| `complexity` | `number` | `1` | Cost of the field for `maxComplexity`. See [limits](#limits). |

The TypeScript type of the property is checked against the GraphQL type at compile time:

- a non-null field must not include `null` or `undefined`, so declare it `name!: string`;
- a nullable field must include both, so declare it `bio?: string | null`;
- a list field takes `T[]` or `readonly T[]`;
- a `defaultValue` must be a value of the field's type.

A mismatch is a compile error on the decorator that names the expected type.

### Type references

The thunk returns one of these:

| Thunk returns | GraphQL type |
| --- | --- |
| `String` | `String` |
| `Boolean` | `Boolean` |
| `Number` | `Float` |
| `Int`, `Float`, `ID` (exported handles) | `Int`, `Float`, `ID` |
| A class decorated with `@ObjectType()`, `@InterfaceType()` or `@InputType()` | That type |
| A handle from `defineEnum()`, `defineScalar()` or `defineUnion()` | That enum, scalar or union |
| `[T]`, one of the above in an array | A list of `T` |

The type is a thunk, not a value, so a field can refer to a class declared later in the file or in a
module that imports this one. A thunk that returns `undefined` (usually a circular import) or throws
is a `SchemaBuildError` that names the field and the class it guessed from the thunk.

Use `Int` for whole numbers: `Number` maps to `Float`.

### Nullability and lists

For a single value, `nullable: true` makes it nullable. For a list, `nullable` chooses the level:

<<< graphql/blog.types.ts#lists title="blog.types.ts"

| `nullable` | SDL for `() => [String]` | TypeScript type |
| --- | --- | --- |
| omitted or `false` | `[String!]!` | `string[]` |
| `'items'` | `[String]!` | `(string \| null \| undefined)[]` |
| `'list'` or `true` | `[String!]` | `string[] \| null \| undefined` |
| `'both'` | `[String]` | `(string \| null \| undefined)[] \| null \| undefined` |

`'items'`, `'list'` and `'both'` on a type that is not a list is a `SchemaBuildError`.

### Interfaces

<<< graphql/blog.types.ts#interface title="blog.types.ts"

An object type lists its interfaces in `implements` (a thunk), and inherits the interface's fields
when its class extends the interface class, as `Author` and `Post` do above. A subclass that
redeclares a field replaces the inherited one.

A field that returns an interface needs to know the concrete type of each value. Without a
`resolveType` option, Knead picks the most derived implementing class that the value is an
`instanceof`, and then falls back to the value's `__typename` property. Return class instances, or
give `@InterfaceType({ resolveType })` a function that returns the class or the type name.

Implementations that no resolver returns directly are not reachable from the schema's roots; list
them in the `orphanedTypes` option so they are built.

### Enums

<<< graphql/blog.types.ts#enum title="blog.types.ts"

`defineEnum(values, { name, description, valuesConfig })` accepts a TypeScript enum or a `const`
object. The GraphQL names are the keys and the runtime values are the object's values, so a field
typed `PostStatus` serializes `PostStatus.DRAFT` as `DRAFT`. The reverse-mapping keys of numeric
enums are skipped. `valuesConfig` adds a `description` or `deprecationReason` per value.

### Custom scalars

<<< graphql/blog.types.ts#scalar title="blog.types.ts"

`defineScalar<T>(scalar)` wraps a `GraphQLScalarType` from `graphql` in a typed handle: a field
typed `DateTime` must be a `Date` in TypeScript. Throw a `GraphQLError` from `parseValue` and
`parseLiteral` to reject input: an invalid variable is reported as `BAD_USER_INPUT`, and an invalid
literal in the document fails validation (see [request errors](#request-errors)).

### Unions

<<< graphql/blog.types.ts#union title="blog.types.ts"

`defineUnion({ name, description, types, resolveType })` takes the member classes as a thunk; each
must be an `@ObjectType()`. Like interfaces, a value is matched to its class with `instanceof`, then
by `__typename`, unless you pass `resolveType`. A field typed with the union must accept every
member in TypeScript (`Post | Author`).

### Input types

<<< graphql/blog.types.ts#input title="blog.types.ts"

An `@InputType()` class can only be used for arguments and input fields, and an `@ObjectType()`
only for output; mixing them up is a `SchemaBuildError`. Input fields take `defaultValue`.

### Argument classes

<<< graphql/blog.types.ts#args title="blog.types.ts"

An `@ArgsType()` class is a reusable set of arguments: its fields become the arguments of every
resolver that passes `args: PostsArgs`, and subclasses inherit them. It is not a GraphQL type
itself.

## Write resolvers

A resolver is a class decorated with `@Resolver()`. It is a singleton provider, so it uses
`inject()` like any other, and it must be listed in a module's `providers`:

<<< graphql/blog.module.ts#blog-module title="blog.module.ts"

`@Query()`, `@Mutation()` and `@Subscription()` add root fields; `@ResolveField()` adds a field to
the resolver's type. Each method receives one argument, the resolver context:

<<< graphql/post.resolver.ts#resolver title="post.resolver.ts"

The declared return type is checked against the method: `@Query(() => Post)` must return a `Post`
(or a promise of one), and a method that may return `undefined` needs `nullable: true`. The method
name is the field name; pass `name` to change it.

### The resolver context

`ResolverCtx<Args, Parent>` holds:

| Property | Description |
| --- | --- |
| `args` | The field's arguments, after GraphQL coercion and `validate`. |
| `parent` | The object the field belongs to (`@ResolveField`), or the event (subscriptions). `undefined` for queries and mutations. |
| `info` | graphql-js's `GraphQLResolveInfo`. |
| `http` | The request `Ctx`. For subscriptions, a per-operation view of the WebSocket upgrade request. |
| `state` | Scratch space shared by every resolver of one operation. |
| `meta` | Metadata: the resolver's `meta` option and `createRouteDecorator()` values from the class and method. |
| `loader(Cls)` | A per-operation DataLoader. See [batch loading](#batch-loading). |

The object returned by the module's `context` factory is spread into the same object, so its keys
sit next to these (`ctx.member` below). The fixed properties are written after it: a context key
named `args`, `parent`, `info`, `http`, `state`, `meta` or `loader` is overwritten, so do not use
those names.

### Arguments

Declare arguments in the `args` option, either as an inline map or as an `@ArgsType()` class:

- an inline map takes type references (`{ id: ID, tags: [String] }`) or full specs
  (`{ after: { type: () => ID, nullable: true, defaultValue: 'p1', description: '...' } }`);
- `args: PostsArgs` uses the fields of an `@ArgsType()` class. A map and a class cannot be combined.

The method's `ResolverCtx<Args>` must agree with what was declared, and a `defaultValue` must be a
value of its argument's type; both are compile errors otherwise. To avoid writing the argument type
twice, derive it from the options with `ArgsOf`:

<<< graphql/post.resolver.ts#args-of title="post.resolver.ts"

### Field resolvers

`@ResolveField(() => Author)` in a `@Resolver(() => Post)` class adds an `author` field to `Post`,
resolved by the method; `ctx.parent` is the `Post`. A `@ResolveField()` in a `@Resolver()` without a
type is a `SchemaBuildError`, and so is a second resolver for the same field.

An `@ObjectType()` subclass of `Post` inherits `author`, with its resolver and guards; a
`@Resolver(() => Subclass)` may declare its own `author`, which wins for the subclass. The resolver
type must be an object type: graphql-js resolves an interface's fields on the concrete type, so
`@ResolveField()` in a `@Resolver(() => SomeInterface)` is a `SchemaBuildError`. Resolve the field
on each implementing type instead.

In a typed resolver, every public method whose first parameter is a `ResolverCtx<Args, Parent>`
must have a `Parent` that accepts the resolver's type; a mismatch is a compile error on
`@Resolver()`. Queries and mutations use the default parent, `undefined`, and pass. Subscription
methods take a `SubscriptionCtx` instead (see [subscriptions](#subscriptions)). A helper method that
takes a context for another parent must be `#private`.

### Validate arguments

The `validate` option maps argument names to [Standard Schema](https://standardschema.dev)
validators, such as valibot schemas:

<<< graphql/post.resolver.ts#validate-schemas title="post.resolver.ts"

Each schema runs after GraphQL has coerced the argument, and its output replaces the argument in
`ctx.args`, so transforms such as `v.trim()` and defaults reach the resolver (the `createPost`
mutation above relies on this). When any schema fails, the resolver is not called and the field
fails with an `ArgsValidationError`, reported as `BAD_USER_INPUT` with every issue:

```json
{
  "data": null,
  "errors": [
    {
      "message": "Argument validation failed",
      "locations": [{ "line": 1, "column": 3 }],
      "path": ["posts"],
      "extensions": {
        "issues": [
          { "arg": "first", "message": "Invalid value: Expected <=50 but received 100", "path": [] }
        ],
        "code": "BAD_USER_INPUT"
      }
    }
  ]
}
```

`issues[].path` is the path inside the argument (for an input object, the field names). A
`validate` key that names no declared argument is a `SchemaBuildError`. Guards run before
validation; see [order of checks](#order-of-checks).

### Unions and interfaces in resolvers

A field typed with a union or an interface returns instances of the member classes:

<<< graphql/post.resolver.ts#search title="post.resolver.ts"

## Context

### The context factory

The module's `context` option is a function of the request `Ctx` that returns an object (or a
promise of one). Over HTTP it runs once per request. Over WebSocket it runs with the upgrade request
once when the connection initializes (for `closeWhere`) and again for every `subscribe` operation.
If it throws when the connection initializes, the failure is logged and the socket is closed with
`4403`, so no connection runs without the identity `closeWhere` matches on. Type what it returns by
augmenting `GraphQLContext`:

<<< graphql/sessions.ts#context-type title="sessions.ts"

Every `ResolverCtx` then has a typed `ctx.member`. The augmentation is global for the program, so
declare each property once.

Over HTTP the factory runs before GraphQL execution starts. An `HttpException` it throws becomes
that exception's HTTP problem response (a `ForbiddenException` is a `403`), and any other error a
`500` problem response.

### Batch loading

A field resolver on a list runs once per item. To fetch the authors of twenty posts in one query
instead of twenty, write a batch loader:

<<< graphql/blog.service.ts#loader title="blog.service.ts"

`ctx.loader(AuthorsById)` returns a [DataLoader](https://github.com/graphql/dataloader) created for
the current operation, so every `Post.author` of one request lands in a single `batch()` call, and
nothing is cached across requests. Each module gets its own DataLoader for a loader class, built
over the provider that module sees. The loader class itself is a singleton: it is the provider when
the resolver's module can see one (as `AuthorsById` is in `BlogModule`), and otherwise it is
constructed once with `inject()` available. `batch(keys)` must return one value or `Error` per key,
in key order. An `options` property is passed to DataLoader as its options.

## Guards

Resolvers use the same guards as controllers: a function, an object with `canActivate()` or a class
with a `canActivate()` method, receiving the `ResolverCtx`. A guard passes only when it returns (or
resolves to) exactly `true`. Any other value, including truthy objects, strings and numbers, makes
the field `FORBIDDEN` with the message `Forbidden`; a guard can also throw an `HttpException` to
report another code. See [guards](/guide/guards/) for the general model.

<<< graphql/guards.ts#guards title="guards.ts"

Attach guards with `@UseGuards()` on the resolver class or method (from `@knead-js/http`), with the
`guards` option of a field, or for every root field with the module's `guards` option:

<<< graphql/guards.ts#resolver title="account.resolver.ts"

<<< graphql/guards.ts#module title="app.module.ts"

### Order of checks

For a query, mutation or subscription field, in this order:

1. With `defaultDeny: true`, a field that is not `@Public()` and has no guard of its own (steps 3
   to 5, or `authorize`) is denied.
2. The module's `guards`, unless the field or its class is `@Public()`.
3. The class's `@UseGuards()` guards.
4. The field's `guards` option.
5. The method's `@UseGuards()` guards.
6. The `validate` schemas.
7. The field's `authorize` guards, which see the validated arguments.
8. The resolver method.

Guards before `validate` see the coerced but unvalidated arguments. Put authorization that depends
on the validated or transformed arguments in `authorize`, as `transfer` does above: `amount: 500` is
`FORBIDDEN`, `amount: 0` fails validation, and a member without the `admin` role is `FORBIDDEN`
before validation runs.

A `@ResolveField()` runs steps 3 to 8 only: the module's `guards` and `defaultDeny` protect entry
points, not nested fields.

### Public fields and default deny

`@Public()` on a resolver class or root field skips the module's `guards` and satisfies
`defaultDeny`. The field's own guards still run, and it sets `ctx.meta[IS_PUBLIC]` to `true`.
`@Public()` is GraphQL-only: an HTTP global guard (`APP_GUARD`) still runs once on the `/graphql`
request itself.

`defaultDeny: true` makes forgetting a guard fail closed: a root field that is neither `@Public()`
nor protected by a guard of its own (class or method `@UseGuards()`, or the `guards` or `authorize`
option) is
`FORBIDDEN`. The module's `guards` do not count, so every field states its authorization:

<<< graphql/guards.ts#forgotten title="stats.resolver.ts"

> [!WARNING]
> `defaultDeny` covers root fields only. `@ResolveField()` methods and plain `@Field()` properties
> are reachable from every root field that returns their type, so protect sensitive data there with
> guards on the field resolver or with field guards.

### Field guards

`@UseFieldGuards(...guards)` on an `@ObjectType()` class runs its guards before every field of that
type, plain `@Field()` properties and `@ResolveField()` methods alike, wherever the type appears in
a response:

<<< graphql/guards.ts#account title="account.ts"

Each guard receives a `ResolverCtx` whose `parent` is the object being resolved, `info.fieldName` the
field and `meta` the type's `createRouteDecorator()` values. A denied field is `null` with a
`FORBIDDEN` error, and a `@ResolveField()` method is not called. For a non-null field, graphql-js
nulls the nearest nullable parent instead: in the example, `account(id: "a1")` for another member
returns `account: null`, because `id` is non-null.

Field guards stack when the decorator is repeated, and a subclass inherits its parent's field guards.
Decorate concrete object types: field guards on an `@InterfaceType()` or `@InputType()` would never
run, so they are a `SchemaBuildError`. Guard classes are
resolved from the root module. Types without field guards keep graphql-js's default resolvers and
cost nothing extra per field.

For permission rules, catalogs and per-field abilities built on these mechanisms, see
[authorization](/guide/authorization/).

## Subscriptions

A `@Subscription()` field streams events from the `PUBSUB` engine. Publish an event with
`inject(PUBSUB).publish(topic, payload)`, as the `createPost` mutation does, and subscribe to it:

<<< graphql/post.subscriptions.ts#subscriptions title="post.subscriptions.ts"

| Option | Description |
| --- | --- |
| `topic` | A topic string, or a function of the `SubscriptionCtx` that returns one or more topics. |
| `filter` | `({ payload, args, ctx }) => boolean`, run per event; `false` skips the event for this subscriber. `ctx` carries the current context (after the latest `refreshContext`). |
| `resolve` | `(payload) => value`, applied to each event before the method. |
| `recheckGuards` | Re-run the guards before every event. Default `false`. See [ending subscriptions](#ending-subscriptions). |

The method receives a `SubscriptionCtx<Args, Event>` whose `parent` is the event (after
`resolve`). It returns the field's value, or nothing, in which case the event itself is sent.

Arguments, `validate`, `guards`, `authorize` and the module's guards work as for queries; guards run
once, when the operation subscribes.

> [!IMPORTANT]
> A topic function usually embeds client input. A computed topic that contains `*` or `#`
> (wildcards on engines that support patterns) or is longer than 256 characters, or a list of more
> than 100 distinct topics, is rejected with `BAD_USER_INPUT` before anything subscribes. Duplicate
> topics are subscribed once. Static topic strings are not checked.

### The WebSocket transport

Subscriptions use the `graphql-transport-ws` protocol on the GraphQL path. The socket runs
subscription operations only: a query or mutation sent over it gets the error
`Only subscription operations are allowed over WebSocket.` and never executes. Over HTTP (without
[SSE](#subscriptions-over-sse)), a subscription is a `400`; when SSE is on and the schema has a
Subscription type, its message also points at `Accept: text/event-stream`.

Browsers cannot set an `Authorization` header on a WebSocket, so a client sends its credentials as
`connectionParams` in `connection_init`. `subscriptions.onConnect(http, params)` receives them:
return `false` to close the socket with code `4403`, or an object to merge into the context of every
operation on that socket (over the `context` factory's result). The `app.module.ts` above verifies a
token this way.

> [!CAUTION]
> `params` is whatever the client sent. Return only values you derived and verified, never `params`
> itself or a spread of it, or the client chooses its own context (`member`, roles). The
> `ConnectionParams` type makes returning or spreading it a compile error.

The `context` factory and `onConnect` must settle within `subscriptions.connectionInitTimeout`
(default 3000 ms, counted from `connection_init`), or the socket is closed with `4408`
(`Connection initialization timeout`, and a warning is logged: the socket's slot stays held until
they settle). A socket that closes while they are pending keeps its connection slot until they
settle, so clients cannot pile up pending `onConnect` work past `maxConnectionsPerIp` by
connecting and disconnecting, and `onConnect` is skipped when the socket closed while the factory
ran.

Browser upgrades must come from the server's own origin, or from one of
`subscriptions.allowedOrigins` (`'*'` allows any); others get `403`. Upgrades without an `Origin`
header (non-browser clients) are allowed. The upgrade request also passes global middleware and
global guards; see [WebSockets](/guide/websockets/) for the origin rules behind proxies and the
socket limits.

### Subscriptions over SSE

The GraphQL path also speaks [graphql-sse](https://github.com/enisdenjo/graphql-sse) (Server-Sent
Events) in distinct connections mode: one HTTP request, one operation, one event stream. It is on
by default, and it works where WebSockets are blocked or awkward, such as some proxies, serverless
and edge hosts. A `POST` or `GET` is answered over SSE when its `Accept` header prefers
`text/event-stream` strictly over `application/json` and `application/graphql-response+json`.
`Accept: */*` alone, or a tie, keeps the JSON response, so existing clients are unaffected.

- A subscription streams each result as an `event: next`, then `event: complete` when it ends.
- A query or a mutation answers one `next` and then `complete`.
- A mutation over `GET` is `405` with `Allow: POST`, as over HTTP.
- Streams carry `cacheControl` (default `no-store`) and `X-Content-Type-Options: nosniff`, as
  JSON responses do.

The request is an ordinary request to the route, so global middleware and guards, the endpoint's
`guards`, the body and query limits and the `context` factory apply. The subscription itself
behaves as over WebSocket: root, `authorize` and field guards, `recheckGuards` with
`refreshContext`, the `filter`, fresh per-event state, the topic rules and error masking. The
playground keeps using WebSocket.

The document goes through Leaven once: it is parsed (after the application's `onParse` hook),
checked against Knead's limits and validated, and only then does the operation type decide what
happens. A query or mutation runs at once, its `context` factory called just before; a
subscription takes its connection slot and runs `onConnect` (below). So a document that fails a
limit or validation never takes a slot or runs `onConnect`, and the pre-execution hooks run once
per request.

To keep subscriptions on WebSocket only, set `subscriptions.sse` to `false`; a request asking for
`text/event-stream` then gets the usual JSON response:

<<< graphql/sse.ts#opt-out title="app.module.ts"

`subscriptions: false` turns off both transports. A schema without a Subscription type keeps SSE
for queries and mutations.

#### Authenticating SSE subscriptions

graphql-sse has no `connection_init`, so `onConnect` runs once per SSE subscription request, after
the `context` factory, with the request's `Ctx` and `{}` as `params`. Queries and mutations over SSE
do not run it: they get the `context` factory alone, as over HTTP. An object result is merged over
the context; `false`, a throw (logged) or a throwing `context` factory answers `403` with a JSON
body (`{"errors":[{"message":"Forbidden","extensions":{"code":"FORBIDDEN"}}]}`) before any stream
starts. An `onConnect` that reads only `params` therefore refuses every SSE subscription: read the
`Authorization` header or a session cookie from `http.req.headers` as well, as the `app.module.ts`
above does.

An SSE request with an `Origin` header must come from the server's own origin or one of
`subscriptions.allowedOrigins`, as for WebSocket upgrades; others get `403`, checked before the body
or the CSRF header is read, and requests without `Origin` are allowed. A `GET` must carry one of `csrf.requiredHeaders`, as every `GET` does (`400`
otherwise). The `graphql-sse` client sends a `POST` with `fetch`, which needs no CSRF header
(`Content-Type: application/json` already forces a CORS preflight) and can carry an
`Authorization` header. A bare browser `EventSource` sends a `GET` and cannot set headers, so it
only works with `csrf: false`, which turns the check off for every `GET` on the endpoint, JSON
queries included.

#### Limits, revocation and lifetime

- An open subscription stream holds a connection slot shared with WebSockets: the same
  `listen({ websocket: { maxConnectionsPerIp } })` (default 100, `429` past it) and
  `maxConnections` (`503`), answered as `application/problem+json` before the stream starts. The
  slot is taken before the `context` factory and `onConnect` run and given back only once they
  have settled, even when the client aborts first, so clients cannot pile up pending `onConnect`
  work (database or token lookups) past the limits by opening and aborting requests. A request
  already aborted runs neither, and one aborted while the factory runs skips `onConnect`. Past
  `subscriptions.connectionInitTimeout` (default 3000 ms) a pending request answers `503`, and its
  slot still comes back only when `onConnect` settles: a warning is logged then (over WebSocket
  too), and a debug line once the pending work settles. After that, the slot is given back when the
  stream ends or the client disconnects (which also ends the subscription). Queries and mutations
  over SSE finish at once and take no slot. A `subscription` on a schema without a Subscription
  type is refused as over JSON (`400` over `POST`, `405` with `Allow: POST` over `GET`), without
  running `onConnect`.
- `GraphQLSubscriptions.closeWhere(predicate)` also ends the matching streams and counts them in
  its result. A revoked stream ends **without** `complete`, so the client can tell it did not finish
  normally. A stream still in `onConnect` is checked again when `onConnect` settles and then answers
  `403`; one ended before `onConnect` settles (a predicate already matching on `http`, more than
  `maxPendingRevocations` kept predicates, or shutdown) answers `503`.
- `subscriptions.maxConnectionLifetime` ends a stream, also without `complete`, that long after it
  took its slot, so the client reconnects and passes `onConnect` again.
- `app.close()` ends every open stream at once, so streams never hold shutdown until
  `shutdownTimeout`; a stream starting during shutdown gets `503`.

#### Keep-alive and the idle timeout

An open stream is an HTTP request, so Bun's `listen({ idleTimeout })` (10 seconds by default)
closes it when it stays quiet. Streams are not exempt from it: they send a keep-alive comment (`:`)
instead, and one comment as soon as the stream starts, so the client sees the response at once.
Without `subscriptions.sse.keepAliveInterval`, the interval is half the `idleTimeout`, at most
`SSE_MAX_KEEP_ALIVE` (8000 ms): 5000 ms with Bun's default, 8000 ms with `idleTimeout: 0`. Bun checks idle connections on a
tick of about 4 seconds, so when the schema has a Subscription type:

- an explicit `keepAliveInterval` above half a non-zero `idleTimeout` makes `listen()` throw an
  `HttpConfigError`;
- an `idleTimeout` of 1 to 4 seconds logs one warning at `listen()`, because Bun may close a quiet
  stream at its next tick whatever the keep-alive. Use `idleTimeout` of 5 or more (or 0), or turn
  SSE off.

#### Request errors over SSE

A request error, one rejected before any resolver ran, is answered as JSON
(`Content-Type: application/json; charset=utf-8`, with `cacheControl`), never as a stream: `400`,
or `500` when an error is `INTERNAL_SERVER_ERROR`. That covers syntax errors and the parser limits,
Knead's limits (`maxDepth`, `maxFields`, `maxAliases`, `maxIntrospectionDepth`), validation,
complexity, operation selection, variables that do not coerce, an `onParse`, `onParsed`,
`onValidate` or `onValidated` hook that throws, and a document `cache` that throws (the `500`
case: an `INTERNAL_SERVER_ERROR`, masked). Everything after execution started is streamed as a
`next` carrying `errors`, then `complete`: a resolver error, an argument `validate` failure, a
throwing `onExecute` or `onExecuted` hook, or `data: null`. Rejections before GraphQL runs (the
origin and CSRF checks, a too-long query, a malformed body, the connection limits) are
`application/problem+json`, as on any route.

#### Clients

The [`graphql-sse`](https://github.com/enisdenjo/graphql-sse) client's `createClient()`, given the
GraphQL path as `url` (and `headers` for credentials), uses its default distinct connections mode.
It treats every response other than `200` as a network error and retries it, up to `retryAttempts`
times (default 5) with randomised exponential backoff. That is why only request errors get another
status: nothing ran, so a retry is harmless, whereas an execution error answered that way would run
a mutation again on every retry. Set `retryAttempts: 0` to surface request errors at once. A stream
that ends without `complete` was revoked or expired: reconnect, which runs `onConnect` again.

Without a library, `fetch` is enough. This client yields each result, ends on `complete`, and
throws when the stream ends without it:

<<< graphql/sse.ts#client title="sse-client.ts"

In tests, `app.subscribeSse(query, options)` from `@knead-js/testing` does the same against the
test server (see [testing](#testing)).

### Events

- Each event gets fresh `ctx.loader()` DataLoaders and an empty `ctx.state`, before its `filter`
  and its `recheckGuards` recheck run, so a guard that memoises roles in `ctx.state` or loads them
  through `ctx.loader()` never reuses what subscribe time or an earlier event cached. The event's
  resolvers see what its filter and recheck set. `ctx.meta` and the connection's context are the
  same for every event.
- One payload is shared by every subscriber, so its plain objects and arrays are deep-frozen when it
  arrives (`deepFreeze`); the in-memory `PubSub` freezes it in `publish()`, even with no
  subscriber. Class instances, `Date`s and `Map`s are not frozen or walked into. Publish
  plain DTOs, not entities, and build new objects in `resolve` or the method instead of changing the
  payload.
- A subscriber more than 1000 events behind loses the oldest, and a warning is logged once per
  subscription.

### Ending subscriptions

By default, authorization is decided when the socket connects and when each subscription starts.
Three tools revoke access later:

- `recheckGuards: true` re-runs the module, class and method guards and then the `authorize` guards
  before every event. An event they deny is delivered as `FORBIDDEN` (or the guard's own error) and
  the subscription completes. Rechecked guards see the connect-time identity; set
  `subscriptions.refreshContext({ http, context })` to look it up again before every recheck. Its
  object result is merged over the operation's context, and `false` ends the subscription with
  `FORBIDDEN`.
- `subscriptions.maxConnectionLifetime` (milliseconds) closes every socket with `4408` after that
  long, so clients reconnect and pass `onConnect` again.
- `GraphQLSubscriptions.closeWhere(predicate)` closes the sockets (and ends the
  [SSE streams](#limits-revocation-and-lifetime)) whose connection matches, for example on
  sign-out:

<<< graphql/revocation.ts#close-where title="sign-out.service.ts"

`closeWhere` closes sockets with code `1008` and reason `Connection revoked` by default and returns
how many sockets and SSE streams it ended. `connection.context` is the `context` factory result
(computed once, when the connection initializes) with the `onConnect` result merged over it. A
socket or stream still in `onConnect` is checked again when `onConnect` completes, so it cannot
slip through.

### Several instances

The default engine, the in-memory `PubSub`, delivers events within one process. When several
instances serve subscriptions, pass a `RedisPubSub`:

<<< graphql/redis.ts#redis title="app.module.ts"

`RedisPubSub` uses `Bun.redis`, with a dedicated subscriber connection. `publish()` never rejects (a
failed publish is logged and the event is lost); `publishOrThrow()` rejects. Without `signingKey`,
anything that can publish to the Redis server can inject events, so set it (at least 32 bytes, the
same on every instance) whenever the server is shared or remote; `encryptionKey` also hides the
payloads from the server. Messages are JSON, so a `Date` arrives as a string. If the subscriber
connection drops, every subscription on the instance ends with an error (clients resubscribe) and
the next subscription opens a new connection. The application closes the engine on shutdown. The
[package reference](/packages/graphql/#redispubsub) lists every option.

## Errors

Errors thrown by resolvers, guards and validation are reported in the response's `errors` with an
`extensions.code`:

| Thrown | `extensions.code` | Message |
| --- | --- | --- |
| `BadRequestException` (and subclasses such as `ArgsValidationError`) | `BAD_USER_INPUT` | Kept |
| `UnauthorizedException` | `UNAUTHENTICATED` | Kept |
| `ForbiddenException`, a denying guard | `FORBIDDEN` | Kept |
| `NotFoundException` | `NOT_FOUND` | Kept |
| `TooManyRequestsException` | `RATE_LIMITED` | Kept |
| A `GraphQLError` thrown by resolver code | its own, else `BAD_USER_INPUT` | Kept |
| A `LeavenError` | its own | Kept |
| Anything else | `INTERNAL_SERVER_ERROR` | Masked outside development |

An `HttpException`'s `extensions` are sent next to the code. A variable that does not match its
type is `BAD_USER_INPUT`, and graphql-js quotes the offending value in the message
(`Variable "$first" got invalid value "x"; ...`), so a client sees its own input echoed back.

> [!WARNING]
> Only the five exception classes above map to a client code. Any other `HttpException`, such as a
> `ConflictException` or an `UnprocessableEntityException`, is an `INTERNAL_SERVER_ERROR` and is
> masked in production. Throw one of the five, or map yours with `mapError`.

### Masking

Every other error, including graphql-js output errors (a resolver returning an object for a `String`
field), is logged under a correlation id, and the client gets that id:

```json
{
  "message": "Internal server error",
  "locations": [{ "line": 1, "column": 3 }],
  "path": ["report"],
  "extensions": { "code": "INTERNAL_SERVER_ERROR", "correlationId": "…" }
}
```

The message is masked (`MASKED_MESSAGE`) unless the application is in development or `maskErrors`
is `false`. Outside development the log entry holds only the error's name and its message, with
credentials redacted and truncated to 500 characters; in development it holds the full error,
redacted. Neither the stack nor the error object reaches the log outside development.

### Mapping your own errors

`mapError(error)` runs on errors thrown by resolver code, `hooks`, subscription filters and the
`context` factory over WebSocket, before masking. Return an `HttpException` to report it with that
exception's code and message, or `undefined` to leave the error as it is:

<<< graphql/errors.ts#domain-error title="posts.errors.ts"

<<< graphql/errors.ts#map-error title="app.module.ts"

`mapError` does not see `GraphQLError`s or `LeavenError`s. A mapper that throws is logged, and the
original error is masked as usual. With these resolvers:

<<< graphql/errors.ts#resolver title="editor.resolver.ts"

`draft` reports `NOT_FOUND` with its message, `rename` reports `BAD_USER_INPUT` with
`extensions.field`, `edit` reports `FORBIDDEN` through `mapError`, and `report` is masked.

### Request errors

Errors in the document itself keep their graphql-js message under `maskErrors` and carry a code:
a syntax error or too many tokens is `PARSE_ERROR`, and an unknown field, an invalid literal
argument or a disabled introspection field is `VALIDATION_ERROR`. A missing or unknown operation
name, or a variable that does not coerce, is `BAD_USER_INPUT`.

## HTTP transport

- `POST` requires `Content-Type: application/json` (`415` otherwise) and runs queries and mutations.
  A batched (array) body is a `400`.
- `GET` runs queries only: a mutation is `405` with `Allow: POST`. As a CSRF defense, a `GET` must
  carry one of `csrf.requiredHeaders` (default `x-graphql-request`), otherwise it is a `400`. A
  `GET` carries the query and its variables in the URL, which proxies, access logs and browser
  history record: send tokens and other secrets in a `POST` body.
- Responses carry `Cache-Control: no-store` (they often hold per-user data; change it with
  `cacheControl`, or `false` to send none) and `X-Content-Type-Options: nosniff`.
- A client that names `application/graphql-response+json` in `Accept` (at a q value at least that
  of `application/json`) gets that content type and GraphQL-over-HTTP status codes: `400` for a
  response without data caused by the request, and `500` only for an `INTERNAL_SERVER_ERROR`.
  Every other client gets `application/json` and `200`, errors included.
- Rejections before GraphQL runs (`415`, the CSRF check, a too-long query, a malformed body) are
  `application/problem+json` responses, like any other `@knead-js/http` error.
- A client whose `Accept` prefers `text/event-stream` is answered over
  [SSE](#subscriptions-over-sse) instead.

## Limits

Every operation, over HTTP, SSE and WebSocket, is checked against these limits before it
executes. The defaults are exported as `GRAPHQL_LIMITS`.

| Option | Default | Rejected with |
| --- | --- | --- |
| `maxQueryLength` | `102400` characters (100 KiB) | `400` over HTTP and SSE; an `error` message over WebSocket. Checked before parsing. |
| `parseOptions.maxTokens` | `3000` | A syntax error. Checked while parsing. |
| `maxFields` | `1000` field selections | `FIELD_LIMIT` |
| `maxDepth` | `10` | `DEPTH_LIMIT` |
| `maxIntrospectionDepth` | `20` | `DEPTH_LIMIT` |
| `maxAliases` | `30` | `BAD_USER_INPUT` |
| `maxComplexity` | `1000` | `COMPLEXITY_LIMIT` |

- `maxFields` counts fields both as written in the document (including fragments that are never
  spread) and with fragments expanded where they are spread. It runs before validation, whose
  overlapping-fields rule is quadratic in repeated fields.
- `maxDepth` counts with fragments expanded, and skips the selections inside `__schema` and `__type`
  so introspection works; `maxIntrospectionDepth` caps those, counting `__schema` or `__type` as
  level 1. graphql-js's `getIntrospectionQuery()` (depth 15) passes every default.
- Complexity sums, over every selected field, the field's cost plus half its depth (`0` at the root),
  where the cost is the `complexity` option (default `1`).

<<< graphql/limits.ts#complexity title="reports.resolver.ts"

Here `{ reports { id rows } }` costs `10 + (1 + 0.5) + (25 + 0.5) = 37`. Costs are looked up by field
name, so two fields with the same name on different types share the higher cost.

Raise a limit when your largest legitimate operation needs it, for example a client that sends
large generated documents, or a Relay schema, which spends three levels per connection
(`users { edges { node { ... } } }`):

<<< graphql/limits.ts#limits title="app.module.ts"

`Infinity` or `false` disables a limit. Any other value that is not a positive integer is an
`HttpConfigError` thrown by `forRoot()`. Validation still costs CPU per request, so also
rate-limit the GraphQL route (see [security](/guide/security/)). WebSocket messages have their own
limits: the message size, the message rate per socket (`subscriptions.messageRate`) and the sockets
per IP, described in [WebSockets](/guide/websockets/).

## Introspection and the playground

| Option | Default |
| --- | --- |
| `introspection` | `true` in development, or when `playground` is set to anything but `false`; otherwise `false` |
| `playground` | `true` in development, otherwise `false` |
| `maskErrors` | `false` in development, otherwise `true` |
| `emitSchemaFile` | `'schema.graphql'` in development, otherwise `false` |

With introspection off, a query that selects `__schema` or `__type` fails validation; `__typename`
still works.

The playground (GraphQL Playground, through Leaven) is served for `GET` requests that list
`text/html` explicitly in `Accept`, which a browser navigation does; other `GET` requests are
GraphQL queries. Turning it on outside development logs a warning at bootstrap, because it exposes
the schema.

<<< graphql/playground.ts#playground title="app.module.ts"

The page's subscription URL is `playground.subscriptionEndpoint` when set. Otherwise it is derived
from the request's `Host` header when that is a plain `host[:port]`, and is the relative path for
anything else, so a forged `Host` never reaches the page.

The page sends its own `Content-Security-Policy`, which `@knead-js/security-headers` leaves in
place: it allows its inline script by its sha256 hash and only the exact `cdn.jsdelivr.net` asset
URLs it loads, each pinned with a Subresource Integrity hash (`PLAYGROUND_ASSETS`), and it sends
`Referrer-Policy: no-referrer`. If Leaven's page ever references an asset without a pinned hash, or
its inline script no longer matches `PLAYGROUND_SCRIPT_HASHES`, this is logged once at bootstrap
and the playground answers `503`.

> [!NOTE]
> The playground stores its tabs, queries and the headers you type (including `Authorization`
> tokens) in the browser's `localStorage` for the API's origin. Clear it after using a real token,
> and do not enable the playground on an origin that serves untrusted scripts.

## The schema file

In development, the sorted SDL is written to `schema.graphql` (relative to the working directory)
at every bootstrap; set `emitSchemaFile` to another path, or `false`. To produce the file in CI,
build the application without listening and print the schema with `printSortedSchema()`, which
sorts types and fields so the output is stable:

<<< graphql/print-schema.ts title="print-schema.ts"

## Testing

`@knead-js/testing` starts the application on a random port and has GraphQL clients:
`app.graphql(query, { variables, headers })` posts an operation, and
`app.graphqlSubscribe(query, { connectionParams })` opens a `graphql-transport-ws` connection and
yields each event; `app.subscribeSse(query, { headers })` subscribes over SSE the same way.

<<< graphql/blog.test.ts title="blog.test.ts"

> [!TIP]
> `compile()` defaults to `development: true`, which also turns on `emitSchemaFile` and writes
> `schema.graphql` into the working directory on every run. Pass `development: false`, or set
> `emitSchemaFile: false` in the test module.

See [testing](/guide/testing/) for overrides and the rest of the testing API.
