# @hpmws/graphql

Code-first GraphQL for hpmws on the [Leaven](https://github.com/quinnjr/leaven) engine. Types are TC39-decorated classes, and a GraphQL field type that disagrees with its TypeScript field type is a compile error. Resolvers are ordinary providers that use `inject()`. The endpoint is an ordinary `@hpmws/http` route, so CORS, rate limiting, security headers and global guards apply to it unchanged.

```ts
@ObjectType()
class User {
  @Field(() => ID) id!: string;
  @Field(() => String, { nullable: true }) bio?: string | null; // nullable needs null | undefined
  @Field(() => [Post]) posts!: Post[];
}

@Resolver(() => User)
class UserResolver {
  readonly #users = inject(UsersService);

  @Query(() => User, { args: { id: ID } })
  user(ctx: ResolverCtx<{ id: string }>) {
    return this.#users.get(ctx.args.id);
  }

  @ResolveField(() => [Post])
  posts(ctx: ResolverCtx<{}, User>) {
    return ctx.loader(PostsByAuthor).load(ctx.parent.id); // one batch per operation tick
  }
}

@Module({
  imports: [GraphQLModule.forRoot({ context: (http) => ({ user: http.state.user }) })],
  providers: [UsersService, PostsByAuthor, UserResolver],
})
class AppModule {}
```

- **Scalars:** `ID`, `Int` and `Float` are exported handles. For strings and booleans, use the global `String` and `Boolean`; `Number` maps to `Float`. Use `defineScalar<T>()`, `defineEnum()` and `defineUnion()` for other types. Lists are written `() => [T]` with `nullable: 'items' | 'list' | 'both'`.
- **Arguments:** an inline or `@Field` `defaultValue` must be a value of the declared type (compile error otherwise). Pass an inline map (`{ first: Int, after: { type: () => ID, nullable: true } }`) or an `@ArgsType()` class (`args: PageArgs`), but not both at once. `validate: { arg: standardSchema }` runs after GraphQL coercion, and a failure is reported as `BAD_USER_INPUT` with `extensions.issues`.
- **Guards and metadata:** `guards` options and `@UseGuards()` on the class or method receive the `ResolverCtx`, and class guards run first. A guard that returns `false` produces `FORBIDDEN`. Values from `createRouteDecorator()` appear in `ctx.meta`. Global `APP_GUARD` guards run once per HTTP request and once per WebSocket upgrade (with `ctx.route` set to `null` and `ctx.upgrade` set), not per resolver.
- **Typed resolvers:** in `@Resolver(() => User)`, a `ResolverCtx<Args, Parent>` parent must accept a `User`. Subscription methods take `SubscriptionCtx<Args, Payload>`, whose parent is the event. The check runs on the class, which can't tell decorated methods from undecorated ones, so it applies to every public method whose first parameter is a `ResolverCtx`. A helper that takes a context for a different parent must be `#private`.
- **Errors:** `BadRequestException` maps to `BAD_USER_INPUT`, `UnauthorizedException` to `UNAUTHENTICATED`, `ForbiddenException` to `FORBIDDEN`, `NotFoundException` to `NOT_FOUND` and `TooManyRequestsException` to `RATE_LIMITED`. A `LeavenError` keeps its own code, and a `GraphQLError` thrown by a resolver is sent as is. Variable and argument coercion errors are `BAD_USER_INPUT`. Any other error becomes `INTERNAL_SERVER_ERROR`, including graphql-js output errors (such as a resolver returning an object for a `String` field) and errors thrown by `hooks`, subscription `filter`s or the `context` factory over WebSocket. It is logged, and its message is masked unless `maskErrors: false`.
- **HTTP:** `POST` requires `Content-Type: application/json` (otherwise `415`) and runs queries and mutations; a subscription is `400`. `GET` runs queries only (otherwise `405`) and requires one of the `csrf.requiredHeaders` (default `x-graphql-request`). The operation type is checked on the document Leaven parses and executes, so the check honours `parseOptions` and the document cache. Requests that name `application/graphql-response+json` in `Accept` (with a q value at least that of `application/json`) get GraphQL-over-HTTP status codes: `400` for a rejected request (including a missing or unknown operation name), `500` only for `INTERNAL_SERVER_ERROR`. All other requests get `200`.
- **Subscriptions:** a `graphql-transport-ws` connection on the same path that runs subscription operations only; a query or mutation sent over it gets a `BAD_USER_INPUT` error and never executes. `@Subscription(() => T, { topic, filter?, resolve? })` uses the `PUBSUB` engine, which defaults to an in-memory `PubSub`. Use `new RedisPubSub({ url })` (on `Bun.redis`, with a dedicated subscriber connection) when several instances run; a failed Redis connection is logged, ends the affected subscriptions, and is retried by the next subscriber. Each event gets fresh `ctx.loader()` DataLoaders and a fresh, empty `ctx.state`, so `ctx.state` written at subscribe time (by guards or the `topic` function, for example) is not visible to the resolvers of an event. `ctx.meta` and the connection context (the `context` factory result and the object `onConnect` returned) are visible to every event. A subscriber that falls more than 1000 events behind drops the oldest, and a warning is logged.
- **WebSocket authentication:** the upgrade request passes global middleware (CORS, rate limiting) and global `APP_GUARD` guards; a guard returning `false` is `403`. Browsers cannot set headers such as `Authorization` on a WebSocket, so an `APP_GUARD` that authenticates by header should let upgrades through (`ctx.upgrade` is `{ path }` on upgrades, `null` otherwise) and leave authentication to `subscriptions.onConnect`, which receives the client's `connectionParams`:

  ```ts
  const BearerGuard = (ctx: Ctx) => ctx.upgrade !== null || verify(ctx.req.headers.get('authorization'));
  GraphQLModule.forRoot({
    subscriptions: { onConnect: (_http, params) => verify(params.authorization) && { user: lookup(params) } },
  });
  ```

  Browser upgrades must come from the server's own origin, meaning the `Origin` host equals the request's `Host` header and its scheme matches the connection (`https:` when `ctx.secure`, which honours a trusted proxy's `x-forwarded-proto`, otherwise `http:`), or from one of `subscriptions.allowedOrigins` (`'*'` allows any). Upgrades without an `Origin` header (non-browser clients) are allowed. `@hpmws/http` has no forwarded-host setting, so behind a proxy that rewrites `Host` the same-origin check fails: list your public origins in `allowedOrigins` there. `onConnect(http, params)` runs on `connection_init` and can reject the connection (close code `4403`) or add values to its context. Resolver guards run once, when an operation subscribes, not per event. Authorization is therefore decided when the socket connects and when each subscription starts: a permission revoked later stays in effect for that socket until it closes, so close sockets yourself (or keep subscriptions short-lived) when that matters.
- **Shutdown:** the application calls `close()` on the pubsub engine, including one you passed in as `pubsub`.
- **Production defaults:** introspection and the playground are off, and errors are masked, unless `NODE_ENV=development`. The playground is served only to requests that list `text/html` in `Accept`. Its page sends its own CSP, which allows its inline script by hash and only the exact `cdn.jsdelivr.net` asset URLs it loads. Those assets carry pinned Subresource Integrity hashes (`PLAYGROUND_ASSETS`); if Leaven's page references an asset without one, this is logged once at bootstrap and the playground answers `503`.
- **Bootstrap:** the schema is built and validated when the application is created. Errors name the class and field, for example `User.posts: type thunk returned undefined — is Post imported?`. In development, `emitSchemaFile` writes sorted SDL to `schema.graphql` by default.
- **Testing:** `@hpmws/testing` provides `app.graphql(query, { variables })` and `app.graphqlSubscribe(query)`.

`bun add @hpmws/core @hpmws/http @hpmws/graphql graphql` (`@hpmws/core`, `@hpmws/http` and `graphql@^16` are peer dependencies). Leaven is pre-1.0 and is pinned to `^0.2.1`. Licensed MIT OR Apache-2.0.
