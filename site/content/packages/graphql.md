---
title: @knead-js/graphql
description: Reference for the code-first GraphQL module, its decorators, type helpers, subscription engines, error handling and playground.
---

```bash
bun add @knead-js/core @knead-js/http @knead-js/graphql graphql
```

`@knead-js/core`, `@knead-js/http` and `graphql` (`^16.14.2`) are peer dependencies. The package
runs on Bun 1.4.3 or later and depends on Leaven (`@leaven-graphql/core` and `@leaven-graphql/sse`
0.4.0, `@leaven-graphql/ws` 0.3.1, `@leaven-graphql/errors` 0.3.0, `@leaven-graphql/playground`
0.2.2, pinned exactly), `dataloader` 2.2.3 and `@standard-schema/spec`.

The package turns decorated classes into a GraphQL schema, serves it over HTTP, `graphql-sse` and
`graphql-transport-ws`, and applies limits, error masking and guards with secure defaults. The
[GraphQL guide](/guide/graphql/) walks through a complete API; [authorization](/guide/authorization/)
and [`@knead-js/casl`](/packages/casl/) build permission checks on its guards.

## Module

### `GraphQLModule`

A global module that serves the schema built from every `@Resolver()` provider in the application.

- `GraphQLModule.forRoot(options?: GraphQLModuleOptions): DynamicModule` validates the options at
  once (an invalid limit, path or `playground.subscriptionEndpoint` throws `HttpConfigError`).
- `GraphQLModule.forRootAsync(options: GraphQLModuleAsyncOptions): DynamicModule` resolves the
  options with a factory at bootstrap.

Both register a controller with `POST` and `GET` routes at the path, and provide and export
`PUBSUB`, `GraphQLRuntime` and `GraphQLSubscriptions`.

### `GraphQLModuleAsyncOptions`

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `'/graphql'` | Static, because routes are compiled from decorators. |
| `imports` | `ModuleImport[]` | `[]` | Modules whose exports the factory can `inject()`. |
| `useFactory` | `() => Omit<GraphQLModuleOptions, 'path'> \| Promise<...>` | required | Runs in GraphQLModule's injection context. |

### `GraphQLModuleOptions`

"Development" below means the application's development flag, `HTTP_DEVELOPMENT`, set by
`KneadFactory.create(root, { development })` and defaulting to `NODE_ENV === 'development'`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `'/graphql'` | HTTP and WebSocket path. Must not contain `:` or `*`. |
| `context` | `(http: Ctx) => object \| Promise<object>` | none | Builds the user part of each operation's context: once per HTTP request; over WebSocket once when the connection initializes and once per `subscribe`, with the upgrade request. |
| `playground` | `boolean \| PlaygroundOptions` | development | Serves GraphQL Playground to `GET` requests that list `text/html` in `Accept`. |
| `introspection` | `boolean` | development, or `playground` set to anything but `false` | Allows `__schema` and `__type`. |
| `maxDepth` | `number \| false` | `10` | Deepest selection, fragments expanded, introspection selections excluded. `DEPTH_LIMIT`. |
| `maxIntrospectionDepth` | `number \| false` | `20` | Deepest selection inside `__schema` or `__type`, which counts as level 1. `DEPTH_LIMIT`. |
| `maxComplexity` | `number \| false` | `1000` | Highest query cost. `COMPLEXITY_LIMIT`. |
| `maxQueryLength` | `number \| false` | `102400` | Longest query string in characters, checked before parsing. |
| `maxAliases` | `number \| false` | `30` | Most aliases in a document. `BAD_USER_INPUT`. |
| `maxFields` | `number \| false` | `1000` | Most field selections, as written and with fragments expanded. `FIELD_LIMIT`. |
| `parseOptions` | Leaven `ParseOptions` | `{ maxTokens: 3000 }` | Parser options; `maxTokens: Infinity` disables the token limit. |
| `cache` | Leaven `ExecutorConfig['cache']` | `{ maxSize: 100 }` | Parsed-document cache; `false` disables it. Each entry keeps a whole AST. |
| `compilerOptions` | Leaven `CompilerOptions` | none | Passed to Leaven's compiler. A `complexityCalculator` here replaces the one built from `complexity` options. |
| `hooks` | Leaven `ExecutionHooks` | none | Leaven's extension point. An error a hook throws goes through `mapError`; a mapped `HttpException` keeps its code, anything else is logged and becomes a masked `INTERNAL_SERVER_ERROR`. A throwing `onError` is only logged. |
| `cacheControl` | `string \| false` | `'no-store'` | `Cache-Control` of GraphQL responses; `false` sends none. A value that is not a valid header value is an `HttpConfigError`. |
| `csrf` | `{ requiredHeaders?: readonly string[] } \| false` | `{ requiredHeaders: ['x-graphql-request'] }` | A `GET` must carry one of these headers. An empty list, or an entry that is not a header name, is an `HttpConfigError`; `false` disables the check. |
| `maskErrors` | `boolean` | `true` outside development | Replaces unexpected error messages with `MASKED_MESSAGE`. |
| `mapError` | `(error: unknown) => HttpException \| undefined` | none | Maps errors from resolver code, hooks, subscription filters and the WebSocket `context` factory before masking. |
| `emitSchemaFile` | `string \| false` | `'schema.graphql'` in development, else `false` | Writes the sorted SDL at bootstrap. |
| `orphanedTypes` | `readonly Class[]` | `[]` | Types to build although no field returns them (for example interface implementations). |
| `subscriptions` | `GraphQLSubscriptionOptions \| false` | `{}` | Subscription transport options. The WebSocket endpoint is registered only when the schema has subscriptions. `false` turns off WebSocket and SSE. |
| `pubsub` | `PubSubEngine` | an in-memory `PubSub` logging through `LOGGER` | The engine behind `PUBSUB`. Its `close()` runs on shutdown. |
| `guards` | `readonly GuardRef<ResolverCtx>[]` | `[]` | Guards run on every root field before its own guards, except `@Public()` ones. Not run for `@ResolveField`. |
| `defaultDeny` | `boolean` | `false` | Deny every root field that is neither `@Public()` nor has a guard of its own (`@UseGuards()`, `guards` or `authorize`). Module `guards` do not count. |

Every limit accepts a positive integer, or `Infinity` or `false` to disable it; anything else is an
`HttpConfigError`. Defaults are in `GRAPHQL_LIMITS`.

### `GraphQLSubscriptionOptions`

The `subscriptions` option (exported under this name; it is `SubscriptionOptions` in the source).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onConnect` | `(http: Ctx, params: ConnectionParams) => boolean \| ConnectContext \| Promise<...>` | none | Runs on `connection_init`, after the `context` factory (a factory that throws there closes the socket with `4403` and `onConnect` does not run). `false` (or a throw, which is logged) closes the socket with `4403`; an object is merged into every operation's context on the socket. Over SSE it runs once per subscription request with `params` `{}`, and a refusal answers `403`. |
| `refreshContext` | `({ http, context }) => ConnectContext \| false \| Promise<...>` | none | Runs before every recheck of a `recheckGuards: true` subscription. An object is merged over the context; anything else (`false`, but also `undefined`, `null` or `true`) ends the subscription with `FORBIDDEN`. |
| `connectionInitTimeout` | `number` (ms) | `3000` (Leaven) | Time allowed for `connection_init`, an integer from 1 to 2147483647. |
| `keepAliveInterval` | `number` (ms) | `12000` (Leaven) | Server pings, an integer up to 2147483647; `0` disables them. |
| `maxSubscriptionsPerConnection` | `number` | `100` (Leaven) | Concurrent subscriptions per socket, a positive integer. |
| `allowedOrigins` | `readonly string[] \| '*'` | same origin only | Browser origins allowed to open a socket or send an SSE request besides the server's own. Requests without `Origin` are allowed; others get `403`. |
| `messageRate` | `WsMessageRate \| false` | the server's, 100 messages per 10 s | Per-socket token bucket; exceeding it closes the socket with `1008`. |
| `maxConnectionLifetime` | `number` (ms) | no limit | Closes every socket with `4408` after this long, and ends every SSE subscription stream (without `complete`), an integer from 1 to 2147483647. |
| `sse` | `false \| SseOptions` | `{}` | GraphQL over SSE on the GraphQL path, on by default; `false` turns it off and keeps WebSockets. |

Other socket rules: the client must offer the `graphql-transport-ws` subprotocol (`400` otherwise),
anywhere in its list, and the server answers with it; a second `connection_init` closes the socket
with `4429`; a `subscribe` or `complete` whose id does not match `^[A-Za-z0-9_.:-]{1,64}$` closes it
with `4400`; a `subscribe` before the connection is acknowledged closes it with `4401`; a
`subscribe` whose query is longer than `maxQueryLength` gets an `error` message; a `subscribe`
reusing the id of an active subscription closes it with `4409`, whatever its length; queries and
mutations get an `error` and never run. The timing and count options above are checked at bootstrap
(`HttpConfigError`).

### `SseOptions`

The `subscriptions.sse` option: `false` turns GraphQL over SSE off, an object configures it.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `keepAliveInterval` | `number` (ms) | half the HTTP `idleTimeout`, at most `8000` | Time between keep-alive comments, an integer from 1 to 2147483647. |

Without `keepAliveInterval`, each stream sends a keep-alive every `idleTimeout * 1000 / 2` ms of
`listen({ idleTimeout })`, at most 8000 ms: 5000 ms with Bun's default of 10 seconds, and 8000 ms
when `idleTimeout` is `0`. When the schema has a Subscription type, an explicit
`keepAliveInterval` above half a non-zero `idleTimeout` makes `listen()` throw `HttpConfigError`
(Bun checks idle connections on a coarse tick of about 4 seconds), and an `idleTimeout` of 1 to 4
seconds logs one warning at `listen()`, since Bun may then close a quiet stream whatever its
keep-alive.

A request is answered over SSE (graphql-sse distinct connections mode) when its `Accept` header
prefers `text/event-stream` strictly over `application/json` and
`application/graphql-response+json`; `*/*` alone or a tie stays JSON. A subscription streams each
result as a `next` event and then `complete`; a query or mutation answers one `next` and
`complete`; a `GET` mutation is `405` with `Allow: POST`; a `GET` needs the `csrf` header. A request
error (rejected before any resolver ran: syntax, parser and Knead limits, validation, complexity,
operation selection, variable coercion, a throwing `onParse`, `onParsed`, `onValidate` or
`onValidated` hook, or a throwing document `cache`) is answered as JSON (`application/json`, with
`cacheControl`) at `400`, or `500` for an `INTERNAL_SERVER_ERROR`; anything after execution started
is streamed. An open subscription
stream holds one of the `listen({ websocket })` connection slots shared with sockets, taken before
`onConnect` runs: past `maxConnectionsPerIp` it is `429`, past `maxConnections` `503`, both
`application/problem+json`. `onConnect` refusing (or the `context` factory throwing) answers `403`
with a `FORBIDDEN` JSON body. A stream revoked by `closeWhere`, past `maxConnectionLifetime` or at
shutdown ends without `complete`. See
[subscriptions over SSE](/guide/graphql/#subscriptions-over-sse).

### `PlaygroundOptions`

| Property | Type | Description |
| --- | --- | --- |
| `subscriptionEndpoint` | `string` | WebSocket URL the page connects to: a `ws://` or `wss://` URL or an absolute path. A URL's origin (`wss://host[:port]`) is added to the page's CSP `connect-src`, so another origin works. Without it, the URL is derived from a plain `host[:port]` `Host` header, else the relative path. |

### `ConnectionParams`

`Readonly<Record<string, unknown>>` with a phantom brand: the client's `connection_init` payload,
untrusted. The brand makes returning it, or an object spread from it, from `onConnect` a compile
error.

### `ConnectContext`

`Partial<GraphQLContext>` that cannot be `ConnectionParams`: what `onConnect` and `refreshContext`
may return.

### `resolveOptions()`

`resolveOptions(options: GraphQLModuleOptions, path: string, development?: boolean | string): ResolvedGraphQLOptions`
validates the options and applies the defaults above. `development` is the application's flag, or a
`NODE_ENV` value compared with `'development'` (default `process.env.NODE_ENV`). `GraphQLRuntime`
calls it with `HTTP_DEVELOPMENT`.

### `ResolvedGraphQLOptions`

The read-only result of `resolveOptions()`: every option above with its default applied, the CSRF
header names lower-cased, `playground` as a `boolean` plus `playgroundSubscriptionEndpoint`, and an
`executor` object holding what is passed to Leaven (`maxComplexity`, `cache`, `compilerOptions`,
`parseOptions` with `maxTokens`, `hooks`; `maxDepth` there is always `undefined` because Knead checks
depth itself).

## Type decorators

### `ObjectType()`

`@ObjectType(options?: ObjectTypeOptions)` declares an output object type.

### `ObjectTypeOptions`

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | the class name | GraphQL type name. An anonymous class needs one. |
| `description` | `string` | none | Type description. |
| `implements` | `() => readonly Class[]` | none | `@InterfaceType()` classes this type implements. |

### `InterfaceType()`

`@InterfaceType(options?: InterfaceTypeOptions)` declares an interface.

### `InterfaceTypeOptions`

`name`, `description` and `implements` as for `ObjectTypeOptions`, plus `resolveType?: (value, info)
=> Class | string | undefined`. Without it, the concrete type is the most derived implementing class
the value is an `instanceof`, then the value's `__typename`.

### `InputType()`

`@InputType(options?: InputTypeOptions)` declares an input object type.

### `InputTypeOptions`

`name` (default: the class name) and `description`.

### `ArgsType()`

`@ArgsType()` declares a reusable argument set. Pass the class as a resolver's `args`; its fields,
inherited ones included, become the arguments. It cannot be used as a field type or argument type.

### `Field()`

`@Field(type: () => R, options?: O): FieldDecorator<R, O>` exposes a class field. It cannot decorate
static, private (`#`) or symbol-named fields (a `TypeError` at class definition). Fields are
inherited, and a subclass redeclaration wins.

### `FieldOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `nullable` | `Nullable` | `false` | See `Nullable`. |
| `description` | `string` | none | Field description. |
| `deprecationReason` | `string` | none | Deprecates the field. |
| `defaultValue` | the field's type | none | Input fields and `@ArgsType()` fields only. Checked at compile time. |
| `complexity` | `number` | `1` | Cost for `maxComplexity`. |

### `FieldDecorator`

`FieldDecorator<R, O>`, the type `Field()` returns. It fails to compile when the decorated
property's TypeScript type is not exactly what the GraphQL type produces (`OutType<R, nullable>`,
mutable or readonly arrays), or when `defaultValue` is not a value of the type.

## Type references

### `Int`, `Float` and `ID`

Handles for the built-in scalars: `Int` and `Float` are `ScalarHandle<number>`, `ID` is
`ScalarHandle<string>`. The global constructors `String`, `Boolean` and `Number` map to `String`,
`Boolean` and `Float`.

### `defineScalar()`

`defineScalar<T>(scalar: GraphQLScalarType<T, unknown>): ScalarHandle<T>` wraps a custom scalar.
A value that is not a `GraphQLScalarType` (for example one from a second copy of `graphql`) is a
`TypeError`.

### `defineEnum()`

`defineEnum(values, config): EnumHandle<E[keyof E]>` builds an enum from a TypeScript enum or a
`const` object of strings or numbers. Keys become value names (numeric enums' reverse mappings are
skipped); `config` is `{ name: string; description?: string; valuesConfig?: { [key]?: { description?, deprecationReason?, ... } } }`.
An object with no values is a `TypeError`.

### `defineUnion()`

`defineUnion({ name, description?, types, resolveType? }): UnionHandle<Members>`. `types` is a thunk
returning `@ObjectType()` classes. `resolveType(value, info)` returns a class or a type name;
without it, the most derived matching class wins, then `__typename`.

### `TypeHandle`

`TypeHandle<T, K>`: `{ readonly __kind: 'scalar' | 'enum' | 'union'; readonly name: string }` with a
phantom TypeScript type `T`. The `__kind` brand keeps classes from matching handles structurally.

### `ScalarHandle`

`ScalarHandle<T>`: a `TypeHandle` with `graphql: GraphQLScalarType`.

### `EnumHandle`

`EnumHandle<T>`: a `TypeHandle` with `graphql: GraphQLEnumType`.

### `UnionHandle`

`UnionHandle<T>`: a `TypeHandle` with `description`, `types` and `resolveType`.

### `TypeRef`

A single type reference: a `Class`, a `TypeHandle`, `String`, `Number` or `Boolean`.

### `TypeThunkResult`

What a type thunk returns: a `TypeRef`, or `[TypeRef]` for a list. A list must have exactly one
element.

### `Nullable`

`boolean | 'items' | 'list' | 'both'`. For a single type only `true`/`false` apply. For a list,
`false` is `[T!]!`, `'items'` is `[T]!`, `'list'` or `true` is `[T!]`, `'both'` is `[T]`.

### `TsOf`

`TsOf<R>`: the TypeScript type of one reference: `string`, `number` or `boolean` for the
constructors, the handle's type, or the class's instance type.

### `OutType`

`OutType<R, Nl, RO>`: the TypeScript type of a field or return value declared as `() => R` with
`nullable: Nl`. Nullable levels add `null | undefined`; `RO = true` gives readonly arrays.

### `Class`

`Class<T>`: `abstract new (...args: any[]) => T`.

## Resolvers

### `Resolver()`

`@Resolver(type?: () => Class<T>): ResolverDecorator<T>` marks a class as a resolver and a singleton
provider. With a type, the class may declare `@ResolveField()` methods for that type, and the type is
built even when no field returns it. The type must be an `@ObjectType()`: `@ResolveField()` on an
`@InterfaceType()` (or `@InputType()`) target is a `SchemaBuildError`, since graphql-js resolves an
interface's fields on the concrete type; resolve the field on each implementing type.

### `ResolverDecorator`

`ResolverDecorator<T>`, the type `Resolver()` returns. With a type `T`, it fails to compile when a
public method's `ResolverCtx` parent does not accept `T` (see `ParentMismatches`).

### `ParentMismatches`

`ParentMismatches<I, T>`: the names of the methods of instance type `I` whose first parameter is a
`ResolverCtx` with a parent that `T` does not satisfy. Methods with an `undefined` parent and
`SubscriptionCtx` methods are not checked.

### `Query()` and `Mutation()`

`@Query(type: () => R, options?: ResolverOptions)` and `@Mutation(type, options?)` add a root
field resolved by the method. They return a `ResolverMethodDecorator`.

### `ResolveField()`

`@ResolveField(type: () => R, options?: ResolverOptions): ResolveFieldDecorator` adds a field to
the `@Resolver()` type; `ctx.parent` is the object. `@ObjectType()` subclasses of the type inherit the
field with its resolver and guards; a `@ResolveField()` of the same name on the subclass's own
resolver wins.

### `ResolverOptions`

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Field name (default: the method name). |
| `nullable` | `Nullable` | Nullability of the return type. |
| `args` | `ArgMap \| Class` | Inline arguments, or an `@ArgsType()` class. |
| `validate` | `Readonly<Record<string, StandardSchemaV1>>` | Standard Schemas per argument, run after coercion; their output replaces the argument. A key that is not a declared argument is a `SchemaBuildError`. |
| `description` | `string` | Field description. |
| `deprecationReason` | `string` | Deprecates the field. |
| `complexity` | `number` | Cost for `maxComplexity` (default `1`). |
| `guards` | `readonly GuardRef<ResolverCtx>[]` | Run after the class's `@UseGuards()` guards, before validation. |
| `authorize` | `readonly GuardRef[]` | Run after validation, with the validated `ctx.args`. |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | Merged into `ctx.meta` between the class and method `createRouteDecorator()` values. |

### `ResolverMethodDecorator`

`ResolverMethodDecorator<R, O>`, returned by `Query()` and `Mutation()`. It fails to compile when the
method's `ResolverCtx` arguments differ from `ArgsOf<O>`, when it returns something other than
`OutType<R, O['nullable']>` (or a promise of it), or when an inline argument's `defaultValue` does
not match its type.

### `ResolveFieldDecorator`

`ResolveFieldDecorator<R, O>`, returned by `ResolveField()`: the same checks, and the method's first
parameter, if any, must be a `ResolverCtx` (not a `SubscriptionCtx` or a look-alike).

### `Subscription()`

`@Subscription(type: () => R, options: SubscriptionOptions): SubscriptionMethodDecorator` adds a
subscription field fed by `PUBSUB`. The method receives a `SubscriptionCtx` whose `parent` is the
event (after `resolve`) and returns the value to send, or nothing to send the event. The field runs
only for an operation that subscribed: a subscription document executed any other way (for example
through `GraphQLRuntime.executor.execute`) is `BAD_USER_INPUT` and calls neither its guards nor the
method.

### `SubscriptionOptions`

`SubscriptionOptions<A, N>`: every `ResolverOptions` option plus:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `topic` | `string \| ((ctx: SubscriptionCtx) => string \| readonly string[])` | required | Duplicate topics are subscribed once. A computed topic list of more than 100 distinct topics, or a computed topic containing `*` or `#` or longer than 256 characters, is `BAD_USER_INPUT`. |
| `filter` | `({ payload, args, ctx }) => boolean \| Promise<boolean>` | none | Per event; `false` skips it. Its `ctx` carries the current context, as last replaced by `refreshContext`, and the event's fresh `ctx.state`. An unexpected throw is logged and masked; a client `HttpException` (or one returned by `mapError`) keeps its code. The error is delivered in place of the event and ends the subscription. |
| `resolve` | `(payload) => unknown` | none | Transforms each event before the method. |
| `recheckGuards` | `boolean` | `false` | Re-run the root guards and `authorize` before every event; a denial delivers `FORBIDDEN` and ends the subscription. |

### `SubscriptionMethodDecorator`

`SubscriptionMethodDecorator<R, O>`, returned by `Subscription()`. The method may return
`OutType<R, nullable>`, a promise of it, or nothing.

### `Public()`

`@Public()` on a resolver class or root field: the module's `guards` skip it and `defaultDeny` lets
it through. Its own guards still run. It sets `ctx.meta[IS_PUBLIC]` to `true`.

### `IS_PUBLIC`

The `ctx.meta` key `@Public()` sets: `Symbol('knead:graphql:public')`.

### `UseFieldGuards()`

`@UseFieldGuards(...guards: GuardRef<ResolverCtx<{}, any>>[])` on an `@ObjectType()` class runs the
guards before every field of the type (plain and `@ResolveField`). Only `true` passes; a denied
field is `FORBIDDEN` (null, bubbling to the nearest nullable parent). Repeated decorators append;
subclasses inherit. On an `@InterfaceType()` or `@InputType()` it would have no effect, so it is a
`SchemaBuildError`: decorate the implementing object types. Guard classes are resolved from the root module, and a
type without field guards keeps graphql-js's default resolvers.

### `FIELD_GUARDS`

`Symbol.for('knead:gql:field-guards')`: the route-meta key holding a type's field guard list, so
other packages (such as `@knead-js/casl`) can add field guards without importing this one. A value
that is not an array, or an invalid guard in it, is a `SchemaBuildError` or `HttpConfigError` at
bootstrap.

## Arguments

### `ArgMap`

`Readonly<Record<string, ArgSpec>>`: an inline argument map.

### `ArgSpec`

One argument: a `TypeThunkResult` (`ID`, `[String]`, a class), or
`{ type: () => TypeThunkResult; nullable?: Nullable; description?: string; defaultValue?: unknown; deprecationReason?: string }`.

### `ArgsTs`

`ArgsTs<A>`: the TypeScript type of declared arguments: an `@ArgsType()` class's instance type, or
the mapped types of an inline map.

### `ArgsOf`

`ArgsOf<O>`: `ArgsTs` of an options object's `args`, or `{}` without one. Use it to type `ctx`
from shared options.

### `ArgsValidationError`

`class ArgsValidationError extends BadRequestException`, thrown when a `validate` schema fails.
Message `Argument validation failed`; `issues: ArgsValidationIssue[]`, also sent as
`extensions.issues` with code `BAD_USER_INPUT`.

### `ArgsValidationIssue`

`{ arg: string; message: string; path: string[] }`: the argument, the schema's message and the path
inside the argument.

## Context

### `ResolverCtx`

`ResolverCtx<A = {}, P = undefined>` extends `GraphQLContext`:

| Property | Type | Description |
| --- | --- | --- |
| `args` | `A` | Coerced and validated arguments. |
| `parent` | `P` | Parent object, or the event in subscriptions. |
| `info` | `GraphQLResolveInfo` | graphql-js resolve info. |
| `http` | `Ctx` | The request; for subscriptions, a per-operation view of the upgrade request with its own `state`. |
| `state` | `Record<PropertyKey, unknown>` | Shared by the resolvers of one operation (one event, for subscriptions). |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | Class `ROUTE_META`, the `meta` option and method `ROUTE_META`, merged in that order. |
| `loader(cls)` | `DataLoader<K, V>` | The operation's DataLoader for a `BatchLoader` class. |

The `context` factory's result and the `onConnect` result are spread first, so these properties
override context keys with the same names.

### `SubscriptionCtx`

`SubscriptionCtx<A = {}, P = unknown>`: a `ResolverCtx` for `@Subscription()` methods, whose
`parent` is the event. A typed `@Resolver()` does not check its parent.

### `GraphQLContext`

An empty interface to augment with the `context` factory's fields:
`declare module '@knead-js/graphql' { interface GraphQLContext { member?: Member } }`.

### `BatchLoader`

`BatchLoader<K, V>`: `{ batch(keys: readonly K[]): Promise<readonly (V | Error)[]>; readonly options?: DataLoader.Options<K, V> }`.
A singleton (the registered provider, or constructed once); `ctx.loader(Cls)` creates one DataLoader
over it per operation and per module (each module resolves its own provider), and per event for
subscriptions.

## Subscriptions

### `PUBSUB`

`InjectionToken<PubSubEngine>`: the engine `@Subscription()` fields read from. Publish with
`inject(PUBSUB).publish(topic, payload)`.

### `PubSubEngine`

Leaven's engine interface: `subscribe(topic, callback): () => void` and `publish(topic, payload)`.
Engines may accept a third `onError(error)` argument to `subscribe` to report that a subscription can
no longer receive events; `RedisPubSub` does, and the subscription then fails.

### In-memory `PubSub`

Leaven's in-memory engine, extended so that `publish(topic, payload)` deep-freezes the payload
(`deepFreeze`) before delivering it, whether or not anything is subscribed: a publisher cannot
change a payload after publishing it, with or without listeners. `new PubSub(config?)` with
`maxSubscribersPerTopic` (default 10000; past it `subscribe` throws), `wildcards` (default `false`),
`maxQueueSize` (default unbounded) and `logger`. Without a `logger`, an engine passed as the
module's `pubsub` (like the module's default engine) logs through `LOGGER`, redacted, once the module
initializes; before that, or when it is not given to the module, it logs to `console`. `publish()`
delivers synchronously, in-process only.

### `RedisPubSub`

A `PubSubEngine` on `Bun.redis` for several instances. Payloads are JSON. Subscriptions use a
dedicated duplicate connection; when it or a `SUBSCRIBE` fails, the failure is logged, the topic's
subscriptions end, and the next subscriber retries. When that connection closes later, or Bun
reconnects it (a reconnected connection has lost its channel subscriptions), the loss is logged,
every subscription on every topic ends through `onError` (clients resubscribe), and the next
`subscribe()` opens a new connection. A publisher the engine created itself is reconnected on its
next use after Bun has given up on it (or closed it on `idleTimeout`); a supplied `client` is left
to the caller.

- `new RedisPubSub(options?: RedisPubSubOptions)` validates the options (`HttpConfigError`), and
  warns at construction when there is no `signingKey` and the server is not on loopback, or when the
  URL is plaintext `redis://` or `valkey://` to a non-loopback host. With a supplied `client` both
  checks are skipped (there is no URL to check).
- `publish(topic, payload): Promise<void>` never rejects: a failure is logged and the event is lost.
- `publishOrThrow(topic, payload): Promise<void>` rejects when the payload is not JSON-serializable,
  the message is larger than `maxMessageBytes`, or Redis does not answer within `publishTimeout`.
- `subscribe(topic, callback, onError?)` returns the unsubscribe function; it throws after `close()`.
- `close(): Promise<void>` closes the subscriber connection, and the publisher unless it was a
  supplied `client`. The application calls it on shutdown.

Incoming messages that are too large, unsigned or badly signed, stale, undecryptable or not JSON are
dropped, and drops are logged at most once per 10 seconds per instance with a count. Parsed payloads
are deep-frozen.

### `RedisPubSubOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `RedisClient` | none | Publisher connection, not closed by `close()`. Bypasses the TLS check and the missing-`signingKey` warning; give it `enableOfflineQueue: false` and a `connectionTimeout`. |
| `url` | `string` | Bun's default (`REDIS_URL`, `VALKEY_URL`, else localhost) | Used when no `client` is given. |
| `requireTls` | `boolean` | `false` | Throw instead of warning for a plaintext URL to a non-loopback host. |
| `prefix` | `string` | `'knead:gql:'` | Channel prefix. |
| `logger` | `Logger` | the application's `LOGGER` once GraphQLModule starts | Where failures are reported. |
| `signingKey` | `RedisPubSubKey \| readonly RedisPubSubKey[]` | none | HMAC-SHA256 over the channel, a timestamp and the payload; unsigned, forged and stale messages are dropped. An array rotates keys: sign with the first, accept any. |
| `encryptionKey` | `RedisPubSubKey \| readonly RedisPubSubKey[]` | none | AES-256-GCM with a random IV per message and the channel and timestamp as associated data. Rotates like `signingKey`. With both keys, the payload is encrypted and the envelope then signed. |
| `maxSignatureAge` | `number` (ms) | `60000` | Oldest signed or encrypted message accepted, 1 to 600000. Messages dated more than 60 s ahead are dropped too. |
| `publishTimeout` | `number` (ms) | `2000` | How long a publish waits for Redis. An integer from 1 to `2 ** 31 - 1` (the largest timer delay); anything else is an `HttpConfigError`. |
| `maxMessageBytes` | `number` | `1048576` | Largest message (UTF-8, after signing and encryption), checked before any HMAC, decryption or parsing. |

Keys must be at least 32 bytes; generate one with `openssl rand -base64 32` and use the same keys on
every instance. A captured message can still be replayed on the same channel within
`maxSignatureAge`.

### `RedisPubSubKey`

`string | Uint8Array`: key material. A string counts as its UTF-8 bytes; byte arrays are copied at
construction.

### `eventIterator()`

`eventIterator<T>(engine: PubSubEngine, topics: readonly string[], filter?, options?): AsyncIterableIterator<T>`
subscribes to every topic and yields payloads, deep-frozen, that pass `filter`. It buffers up to
1000 events per iterator and then drops the oldest, calling `options.onDrop()`. `return()`
unsubscribes from every topic. If the engine throws while subscribing to one topic, the topics
already subscribed are unsubscribed and the error is rethrown. `@Subscription()` fields use it.

### `deepFreeze()`

`deepFreeze<T>(value: T): T` freezes the value and every plain object and array reachable from it,
then returns it. Class instances, `Date`s, `Map`s and other non-plain objects are neither frozen nor
walked into.

### `GraphQLSubscriptions`

An injectable service. `closeWhere(predicate: (connection: GraphQLConnection) => boolean, code = 1008, reason = 'Connection revoked'): number`
closes every subscription socket whose connection matches, ends every matching SSE subscription
stream (without `complete`), and returns how many sockets and streams it ended. Sockets and streams
whose `onConnect` is still pending are checked again when it completes (at most
`listen({ websocket: { maxPendingRevocations } })` predicates each, default 10000; beyond that the
socket is closed with `1008` and the stream ended). A pending stream that matches then answers
`403`; one ended before its `onConnect` completed answers `503`. A socket or stream ended only
because it was past that limit counts when the predicate matches its still-empty context. A
predicate that throws for a socket or stream is logged and that one skipped. When nothing matched, a debug entry is logged.

### `GraphQLConnection`

`{ readonly http: Ctx; readonly context: Readonly<Record<PropertyKey, unknown>> }`: the upgrade
request (for an SSE stream, the subscription request) and the connection's identity, the `context`
factory result (computed once at connection init) with the `onConnect` result over it. Empty
before `connection_init` (for an SSE stream, until `onConnect` settles).

Over WebSocket the `context` factory runs once at connection init, for this identity, and again
for every `subscribe`, for the operation's resolvers. The two can drift: if the factory reads
something that changes (a session store, the clock), `closeWhere` predicates see the init-time
result while resolvers see the per-subscribe one. Key revocation on values that do not change for
the socket's life (a session id, the `onConnect` result).

## Errors

### `SchemaBuildError`

`class SchemaBuildError extends KneadError`, thrown at bootstrap for an invalid schema. Its message
names the class and field (duplicate type or field names, an undecorated class, an input type used
as output, a type thunk returning `undefined`, a missing `@Query()`, graphql-js validation errors).

### `MASKED_MESSAGE`

`'Internal server error'`: the message of masked errors.

### `createErrorFormatter()`

`createErrorFormatter(options): (error: GraphQLError) => GraphQLFormattedError`, the Leaven
`formatExecutionError` the runtime installs. `options` is
`{ maskErrors: boolean; logger: Logger; development?: boolean; mapError?: (error: unknown) => HttpException | undefined }`.
It maps `BadRequestException` to `BAD_USER_INPUT`, `UnauthorizedException` to `UNAUTHENTICATED`,
`ForbiddenException` to `FORBIDDEN`, `NotFoundException` to `NOT_FOUND` and
`TooManyRequestsException` to `RATE_LIMITED` (subclasses included), keeps a `LeavenError`'s
extensions and a resolver's own `GraphQLError`, and reports errors without a path (variable
coercion) and graphql-js argument errors as `BAD_USER_INPUT`. Everything else is logged under a
correlation id and returned as `INTERNAL_SERVER_ERROR` with `extensions.correlationId`, its message
replaced by `MASKED_MESSAGE` when `maskErrors`. Outside development the log holds only the error's
name and redacted message, truncated to 500 characters.

## HTTP endpoint

### `createGraphQLController()`

`createGraphQLController(path: string): Type`: the controller class `GraphQLModule` registers, with
`POST` and `GET` routes at `path` and `GRAPHQL_ENDPOINT` in its route meta. Applications do not
normally call it.

### `GRAPHQL_ENDPOINT`

`Symbol.for('knead:gql:endpoint')`: route-meta key on the GraphQL routes (so also on subscription
upgrades). The value is a `GraphQLEndpointGuards` function, so an app-wide HTTP guard can recognize
the endpoint and defer to the resolver guards, as `@knead-js/casl`'s `AbilityGuard` does.

### `GraphQLEndpointGuards`

`() => readonly GuardRef<any>[]`: returns the module's `guards` option.

### `GRAPHQL_RESPONSE_JSON`

`'application/graphql-response+json'`. Clients that name it in `Accept` (at a q value at least that of
`application/json`) get it as the content type, with `400` for a request error without data and `500`
for an `INTERNAL_SERVER_ERROR` without data. Other clients get `application/json` and `200`.

## Runtime

### `GraphQLRuntime`

The provider that owns the schema and the executor. Inject it to read the built schema.

| Member | Description |
| --- | --- |
| `schema` | The `GraphQLSchema`. Throws `SchemaBuildError` before `onModuleInit`. |
| `executor` | The Leaven executor (a `LeavenExecutor` subclass). Its `isRequestError(response)` is `true` for a response its `execute()` or `subscribe()` returned when nothing ran (the SSE request errors above), decided by where the error arose, never by its code. |
| `options` | The `ResolvedGraphQLOptions`. |
| `development` | The application's development flag. |
| `pubsub` | The `PUBSUB` engine. |
| `logger` | The application `LOGGER`. |
| `playground` | The `PlaygroundGate`; throws `SchemaBuildError` when the playground is off. |
| `subscriptionsEnabled` | Whether the subscription endpoint is registered. |
| `connection(ws)` | The `GraphQLConnection` of a subscription socket, or `undefined`. |
| `createOperationContext(http, allowed, extra?)` | Builds one operation's context: the `context` factory result with `extra` over it. |

### `GRAPHQL_OPTIONS`

`InjectionToken<GraphQLModuleOptions>`: the options as given to `forRoot()` or returned by the
`forRootAsync()` factory, before defaults.

### `GRAPHQL_LIMITS`

The frozen default limits: `{ maxDepth: 10, maxComplexity: 1000, maxTokens: 3000, maxQueryLength: 102400, maxAliases: 30, maxFields: 1000, maxIntrospectionDepth: 20 }`.

### `printSortedSchema()`

`printSortedSchema(schema: GraphQLSchema): string`: the SDL of a lexicographically sorted copy of
the schema, with a trailing newline, so it is stable across runs. `emitSchemaFile` writes this.

## Playground

### `PlaygroundGate`

`new PlaygroundGate(logger, assets = PLAYGROUND_ASSETS, scriptHashes = PLAYGROUND_SCRIPT_HASHES)`
checks, once, that Leaven's reference page references only assets with a pinned hash and that its
inline scripts match `scriptHashes`. If not, it logs an error and `available` is `false`.
`serve(endpoint, subscriptionEndpoint?)` returns the page (`200`, with `Content-Security-Policy`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`), or
a plain-text `503` when unavailable. Rendered pages are cached per subscription endpoint (the 16
most recently used, since the endpoint can come from the `Host` header).

### `playgroundPage()`

`playgroundPage(endpoint, subscriptionEndpoint?, assets = PLAYGROUND_ASSETS): { html, csp }`
renders Leaven's page with `integrity` and `crossorigin` on its scripts and stylesheets, and a CSP
that allows its inline scripts by sha256 hash and only the exact asset URLs it loads (the favicon
by its URL in `img-src`; `default-src 'self'`, `font-src 'self' data:`, `connect-src 'self'` plus
the origin of an absolute `ws://`/`wss://` `subscriptionEndpoint`, `frame-ancestors 'none'`,
`object-src 'none'`;
`style-src` includes `'unsafe-inline'` because the bundle injects styles). It throws
`PlaygroundAssetError` for an asset without a hash.

### `playgroundScriptHashes()`

`playgroundScriptHashes(): string[]`: the base64 sha256 of each inline script of the reference page.
Use it to recompute `PLAYGROUND_SCRIPT_HASHES` after upgrading Leaven.

### `PLAYGROUND_ASSETS`

A frozen map from each CDN asset URL Leaven's page loads (`graphql-playground-react` 1.7.28 on
`cdn.jsdelivr.net`) to its `sha384-` Subresource Integrity hash.

### `PLAYGROUND_SCRIPT_HASHES`

The frozen list of base64 sha256 hashes of the reference page's inline scripts
(`KXClm84BZMGQwvs58xNH4U6eMcSJLu9b0rCfFTanBU0=` for `@leaven-graphql/playground` 0.2.2).

### `PLAYGROUND_REFERENCE`

`'/graphql'`: the endpoint the pinned script hashes are computed for.

### `PlaygroundAssetError`

`class PlaygroundAssetError extends Error` with `urls: readonly string[]`, the assets without a
pinned hash.

### `PlaygroundScriptError`

`class PlaygroundScriptError extends Error` with `hashes: readonly string[]`, the inline script
hashes that did not match.
