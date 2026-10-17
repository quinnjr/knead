# @knead-js/graphql

[![npm](https://img.shields.io/npm/v/@knead-js/graphql?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/graphql)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Code-first GraphQL for [Knead](https://github.com/quinnjr/knead) on the
[Leaven](https://github.com/quinnjr/leaven) engine. Types are TC39-decorated classes, resolvers are
ordinary providers that use `inject()`, and a GraphQL field type that disagrees with its TypeScript
type is a compile error.

**[Documentation](https://quinnjr.github.io/knead/packages/graphql/)** · [Guide](https://quinnjr.github.io/knead/guide/graphql/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/graphql @knead-js/core @knead-js/http graphql
```

Requires Bun 1.4.3 or newer. `@knead-js/core`, `@knead-js/http` and `graphql` (`^16.14.2`) are
peer dependencies. Leaven is pre-1.0, so its packages are pinned exactly (`@leaven-graphql/core`
and `@leaven-graphql/ws` 0.2.3, `@leaven-graphql/playground` 0.2.2, `@leaven-graphql/errors` 0.2.1).

## Quick start

```ts
import { inject, Module } from '@knead-js/core';
import {
  type BatchLoader,
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
} from '@knead-js/graphql';

@ObjectType()
export class Author {
  @Field(() => ID) id!: string;
  @Field(() => String) name!: string;
}

@ObjectType()
export class Book {
  @Field(() => ID) id!: string;
  @Field(() => String) title!: string;
  // A nullable field must accept both null and undefined, or it does not compile.
  @Field(() => String, { nullable: true }) subtitle?: string | null;
  /** Not a GraphQL field: `author` is resolved below. */
  authorId!: string;
}

export class Library {
  readonly books: Book[] = [
    { id: 'b1', title: 'Kindred', authorId: 'a1' },
    { id: 'b2', title: 'Parable of the Sower', authorId: 'a1' },
  ];
  readonly authors = new Map([['a1', { id: 'a1', name: 'Octavia E. Butler' }]]);
}

/** Batches every `Book.author` of one operation into a single call. */
export class AuthorsById implements BatchLoader<string, Author> {
  readonly #library = inject(Library);

  async batch(ids: readonly string[]): Promise<(Author | Error)[]> {
    return ids.map((id) => this.#library.authors.get(id) ?? new Error(`No author ${id}`));
  }
}

@Resolver(() => Book)
export class BookResolver {
  readonly #library = inject(Library);

  @Query(() => [Book])
  books(): Book[] {
    return this.#library.books;
  }

  @Query(() => Book, { nullable: true, args: { id: ID } })
  book(ctx: ResolverCtx<{ id: string }>): Book | undefined {
    return this.#library.books.find((book) => book.id === ctx.args.id);
  }

  @ResolveField(() => Author)
  author(ctx: ResolverCtx<{}, Book>): Promise<Author> {
    return ctx.loader(AuthorsById).load(ctx.parent.authorId);
  }
}

@Module({
  imports: [GraphQLModule.forRoot()],
  providers: [Library, AuthorsById, BookResolver],
})
export class AppModule {}
```

This serves `POST` and `GET /graphql`. `{ books { title author { name } } }` resolves both authors
with one `batch()` call, because `ctx.loader()` gives each operation its own DataLoader. The schema
is built and validated when the application is created: a mistake is a `SchemaBuildError` naming
the class and field.

## Features

- **Typed, code-first schema.** `@ObjectType`, `@InterfaceType`, `@InputType`, `@ArgsType`,
  `defineEnum()`, `defineScalar()` and `defineUnion()`; field, argument and return types are
  checked against TypeScript.
- **Resolvers with DI.** Singleton providers with `inject()`, per-operation DataLoaders, and
  [Standard Schema](https://standardschema.dev) argument validation (`validate`).
- **Fail-closed guards.** The `@knead-js/http` guard model on root fields, field guards on types,
  `@Public()` and `defaultDeny`. A guard passes only on exactly `true`.
- **Subscriptions.** `graphql-transport-ws` on the same path, an in-memory or Redis engine with
  signing and encryption, and three ways to revoke access.
- **Limits on by default.** Query length, tokens, fields, depth, aliases and complexity, over HTTP
  and WebSocket.
- **Masked errors.** Unexpected errors reach the client as `Internal server error` with a
  correlation id; the log entry is redacted.
- **Production-safe defaults.** Introspection, the playground and the schema file are on only in
  development.
- **Ordinary HTTP route.** CORS, rate limiting, security headers and global guards apply to the
  endpoint unchanged.

## Types and resolvers

| Thunk returns | GraphQL type |
| --- | --- |
| `String`, `Boolean` | `String`, `Boolean` |
| `Number` | `Float` (use `Int` for whole numbers) |
| `Int`, `Float`, `ID` (exported handles) | `Int`, `Float`, `ID` |
| An `@ObjectType`, `@InterfaceType` or `@InputType` class | That type |
| A `defineEnum()`, `defineScalar()` or `defineUnion()` handle | That enum, scalar or union |
| `[T]` | A list of `T`; choose nullability with `nullable: 'items' \| 'list' \| 'both'` |

- **Compile-time checks.** A non-null field is `name!: string`, a nullable one `bio?: string | null`.
  A `defaultValue` must be a value of its type, and a query's return type must match the method.
- **Arguments.** Pass an inline map (`{ first: Int, after: { type: () => ID, nullable: true } }`)
  or an `@ArgsType()` class, not both. `ArgsOf<typeof options>` derives the TypeScript type.
- **Validation.** `validate: { arg: schema }` runs after GraphQL coercion, and its output replaces
  the argument. A failure is `BAD_USER_INPUT` with `extensions.issues`.
- **Typed parents.** In `@Resolver(() => Book)`, every public method whose first parameter is a
  `ResolverCtx<Args, Parent>` must accept a `Book` parent. A helper for another parent must be
  `#private`.
- **Context.** The module's `context(http)` result is spread into every `ResolverCtx`; type it by
  augmenting `GraphQLContext`. Do not name its keys `args`, `parent`, `info`, `http`, `state`,
  `meta` or `loader`: those are overwritten.

## Guards

Resolvers use the guards of `@knead-js/http` (a function, an object or a class with
`canActivate()`), receiving the `ResolverCtx`. Anything but exactly `true`, including a truthy
object, string or number, makes the field `FORBIDDEN`. For a root field the checks run in this
order:

1. With `defaultDeny: true`, a field that is not `@Public()` and has no guard of its own (step 3 or
   `authorize`) is denied.
2. The module's `guards`, unless the field or its class is `@Public()`.
3. The class's `@UseGuards()`, the field's `guards` option, then the method's `@UseGuards()`.
4. The `validate` schemas.
5. The field's `authorize` guards, which see the validated arguments.
6. The resolver method.

Rules to keep in mind:

- **`defaultDeny` covers entry points only.** The module's `guards` do not count toward it. A
  `@ResolveField()` and plain `@Field()` properties are reachable from every root field that
  returns their type: protect sensitive ones with guards on the field resolver or with field guards.
- **Guards before `validate` see unvalidated arguments.** Put checks that depend on validated or
  transformed arguments in `authorize`.
- **`@Public()` is GraphQL-only.** An HTTP `APP_GUARD` still runs once on the `/graphql` request
  itself (and once per WebSocket upgrade, with `ctx.upgrade` set), not per resolver.
- **Field guards.** `@UseFieldGuards(...guards)` on an `@ObjectType()` runs before every field of
  the type, wherever it appears. A denied field is `null` with `FORBIDDEN`; for a non-null field
  graphql-js nulls the nearest nullable parent, so make deniable fields nullable. Decorate concrete
  object types: field guards on an `@InterfaceType()` or `@InputType()` would never run, so they are
  a `SchemaBuildError`.
- **Subclasses and interfaces.** An `@ObjectType()` subclass of a `@Resolver(() => T)` type inherits
  its `@ResolveField()` methods and their guards. `@ResolveField()` on an `@InterfaceType()` is a
  `SchemaBuildError`: graphql-js resolves the concrete type's field, so resolve it on each object
  type.
- **Bootstrap checks.** An `undefined` guard (a circular import), an arrow-function `canActivate`
  field or an object without `canActivate()` is an `HttpConfigError` naming the resolver or type,
  and never counts for `defaultDeny`.

`GRAPHQL_ENDPOINT` and `FIELD_GUARDS` route meta let other packages, such as
[`@knead-js/casl`](https://quinnjr.github.io/knead/packages/casl/), build on these guards.

## Subscriptions

`@Subscription(() => T, { topic, filter?, resolve?, recheckGuards? })` streams events from the
`PUBSUB` engine over `graphql-transport-ws` on the GraphQL path. The socket runs subscriptions only:
a query or mutation sent over it never executes.

- **Authenticate in `onConnect`.** Browsers cannot set `Authorization` on a WebSocket, so clients
  send credentials as `connectionParams`. `subscriptions.onConnect(http, params)` returns `false`
  (close code `4403`) or an object merged into every operation's context.
- **Never return `params` or spread it** into the result: the client would choose its own context
  (`user`, roles). Return only values you derived and verified. Doing otherwise is a compile error.
- **Same-origin upgrades.** Browser upgrades must come from the server's own origin or from
  `subscriptions.allowedOrigins`; others get `403`, as does `Origin: null`. Behind a proxy that
  rewrites `Host` or `X-Forwarded-Proto`, see the
  [WebSockets guide](https://quinnjr.github.io/knead/guide/websockets/).
- **Topics.** Duplicate topics are subscribed once. A computed topic list of more than 100 distinct
  topics, or a computed topic containing `*` or `#` or longer than 256 characters, is rejected with
  `BAD_USER_INPUT` before anything subscribes. Static topic strings are not checked.
- **Payloads are shared.** Plain objects and arrays are deep-frozen on arrival; class instances,
  `Date`s and `Map`s are not. Publish fresh DTOs, and build new objects in `resolve`.
- **Per-event state.** Each event gets fresh DataLoaders and an empty `ctx.state`. A subscriber
  more than 1000 events behind loses the oldest, with a warning.

Authorization is decided when the socket connects and when each subscription starts. To revoke it
later:

- `recheckGuards: true` re-runs the root and `authorize` guards before every event; pair it with
  `subscriptions.refreshContext` for a live identity lookup (an object is merged over the
  context; `false`, or anything else that is not an object, ends the subscription).
- `subscriptions.maxConnectionLifetime` closes every socket with `4408` after that many
  milliseconds.
- `inject(GraphQLSubscriptions).closeWhere(predicate)` closes matching sockets (code `1008`),
  including ones whose `onConnect` is still pending. Its `connection.context` is the `context`
  factory result from connection init (plus `onConnect`'s); resolvers see the factory's result
  for each `subscribe`, which can differ if the factory reads changing state. Key revocation on
  values fixed for the socket's life, such as a session id.

### Several instances: `RedisPubSub`

The default engine is in-memory. Pass `pubsub: new RedisPubSub({ url })` (on `Bun.redis`) when
several instances serve subscriptions.

- **Sign messages.** Without `signingKey`, anything that can publish to Redis can inject events.
  Set it (at least 32 bytes, the same on every instance, for example `openssl rand -base64 32`)
  whenever the server is shared or remote. Unsigned, forged and stale messages are dropped.
- **Encrypt payloads.** `encryptionKey` (AES-256-GCM) hides payloads from the Redis server. Both
  keys take an array to rotate: sign with the first, accept any.
- **Use TLS.** A plaintext `redis://` or `valkey://` URL to a non-loopback host logs a warning;
  `requireTls: true` makes it throw. A caller-supplied `client` bypasses this check and the
  missing-`signingKey` warning: configure TLS and signing for it yourself.
- **Replay window.** Messages older than `maxSignatureAge` (default 60 s) are dropped, but a
  captured message can be replayed on the same channel within it.
- **Publishing.** `publish()` never rejects (a failure is logged and the event lost);
  `publishOrThrow()` rejects. Payloads are JSON, so a `Date` arrives as a string.

The application calls the engine's `close()` on shutdown, including one you passed in.

## Errors

| Thrown | `extensions.code` |
| --- | --- |
| `BadRequestException` (and `ArgsValidationError`) | `BAD_USER_INPUT` |
| `UnauthorizedException` | `UNAUTHENTICATED` |
| `ForbiddenException`, a denying guard | `FORBIDDEN` |
| `NotFoundException` | `NOT_FOUND` |
| `TooManyRequestsException` | `RATE_LIMITED` |
| A `GraphQLError` thrown by resolver code | its own, else `BAD_USER_INPUT` |
| A `LeavenError` | its own |
| Anything else, including other `HttpException`s | `INTERNAL_SERVER_ERROR`, masked |

- **Masking.** Unexpected errors are logged under a correlation id, which the client gets as
  `extensions.correlationId`. The message is `Internal server error` unless the app is in
  development or `maskErrors: false`.
- **Redacted logs.** Outside development the log entry holds only the error's name and its
  redacted message, truncated to 500 characters, never the stack or the object. The redaction
  happens before `LOGGER` is called, so it holds for any logger.
- **`mapError(error)`** maps errors from resolver code, `hooks`, subscription filters and the
  WebSocket `context` factory to an `HttpException` (or `undefined` to leave them). Over HTTP the
  `context` factory runs before GraphQL: an `HttpException` it throws becomes that HTTP problem
  response, anything else a `500`.
- **Echoed input.** graphql-js quotes an invalid variable's value in its `BAD_USER_INPUT` message,
  so a client sees its own input, and so does anything that records responses.

## HTTP transport

- `POST` requires `Content-Type: application/json` (`415` otherwise) and runs queries and
  mutations. A subscription over `POST` is a `400`.
- `GET` runs queries only (a mutation or subscription is `405`) and, as a CSRF defense, must carry
  one of `csrf.requiredHeaders` (default `x-graphql-request`). A `GET` puts the query and variables
  in the URL, which proxies and logs record: send tokens and secrets in a `POST` body.
- Responses carry `Cache-Control: no-store` (change it with `cacheControl`) and
  `X-Content-Type-Options: nosniff`.
- Clients that accept `application/graphql-response+json` get GraphQL-over-HTTP status codes; all
  others get `200`, errors included.

## Limits

Every operation, over HTTP and WebSocket, is checked before it executes. The defaults are exported
as `GRAPHQL_LIMITS`.

| Option | Default | Rejected with |
| --- | --- | --- |
| `maxQueryLength` | `102400` characters | `400` over HTTP, checked before parsing |
| `parseOptions.maxTokens` | `3000` | A syntax error |
| `maxFields` | `1000` | `FIELD_LIMIT`, checked before validation |
| `maxDepth` | `10` | `DEPTH_LIMIT` |
| `maxIntrospectionDepth` | `20` | `DEPTH_LIMIT` |
| `maxAliases` | `30` | `BAD_USER_INPUT` |
| `maxComplexity` | `1000` | `COMPLEXITY_LIMIT` |

`getIntrospectionQuery()` passes every default. Raise a limit with a larger number when your
largest legitimate operation needs it (Relay schemas spend three levels per connection), or disable
it with `Infinity` or `false`; anything else is an `HttpConfigError`. Validation still costs CPU, so
also rate-limit the route. WebSocket messages have their own size, rate and per-IP connection
limits, described in the [WebSockets guide](https://quinnjr.github.io/knead/guide/websockets/).

## Production defaults

| Option | In development | Otherwise |
| --- | --- | --- |
| `introspection` | on | off (on if `playground` is enabled) |
| `playground` | on | off |
| `maskErrors` | off | on |
| `emitSchemaFile` | `'schema.graphql'` | `false` |

Development is `KneadFactory.create(root, { development })` (the `HTTP_DEVELOPMENT` token), which
defaults to `NODE_ENV === 'development'`. An app created with `development: false` keeps the
production defaults even when `NODE_ENV=development`.

- Enabling the playground outside development logs a warning at bootstrap.
- The playground is served only to `GET` requests that list `text/html` in `Accept`. Its page sends
  its own CSP; its scripts and stylesheets carry Subresource Integrity hashes, and its favicon is
  pinned by exact URL in the CSP's `img-src`. If Leaven's page no longer matches the pinned
  hashes, the playground answers `503`. A `playground.subscriptionEndpoint` on another origin is
  added to the CSP's `connect-src` by its exact origin.
- The playground stores the headers you type, including `Authorization` tokens, in `localStorage`.
  Clear it after using a real token, and do not enable it on an origin that serves untrusted
  scripts.

## Testing

`@knead-js/testing` starts the app on a random port: `app.graphql(query, { variables, headers })`
posts an operation and `app.graphqlSubscribe(query, { connectionParams })` yields subscription
events. Their `path` option is resolved against the test server's URL, so pass paths, never URLs
built from untrusted input.

## Documentation

- [Package reference](https://quinnjr.github.io/knead/packages/graphql/): every option and export.
- [GraphQL guide](https://quinnjr.github.io/knead/guide/graphql/): a complete API step by step.
- [Authorization](https://quinnjr.github.io/knead/guide/authorization/): CASL abilities on GraphQL
  fields.
- [WebSockets](https://quinnjr.github.io/knead/guide/websockets/): origin checks and socket limits.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
