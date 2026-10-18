---
title: @knead-js/testing
description: API reference for testing modules with overrides, captured logs and real ephemeral HTTP, GraphQL and WebSocket servers.
---

```bash
bun add @knead-js/core @knead-js/http
bun add -d @knead-js/testing
```

`@knead-js/core` and `@knead-js/http` are peer dependencies, so every package shares one copy of
them.

The package compiles a real application from module metadata, with providers, guards, middleware
and filters replaced as needed, captures its logs in a `MemoryLogger`, and starts it on a random
local port for requests. The [testing guide](/guide/testing/) shows each feature in a `bun:test`
suite.

## `Test`

### `Test.createModule()`

```text
Test.createModule(metadata: ModuleOptions): TestingModuleBuilder
```

`metadata` is what `@Module()` takes (`imports`, `providers`, `controllers`, `exports`); it
becomes the metadata of a root module that the builder creates.

## `TestingModuleBuilder`

Collects overrides, then compiles. Every override method returns an `OverrideBy` whose methods
return the builder, so calls chain.

| Method | Replaces |
| --- | --- |
| `overrideProvider<T>(token: Token<T>): OverrideBy<T>` | The provider for `token` in every module that registers it (not `multi: true` providers). Has no effect when no module provides the token. |
| `overrideGuard(guard: Type): OverrideBy<Guard<any>>` | A guard class wherever it is referenced. |
| `overrideMiddleware(middleware: Type): OverrideBy<Middleware>` | A middleware class wherever it is referenced. |
| `overrideFilter(filter: Type): OverrideBy<ExceptionFilter>` | An exception filter class wherever it is referenced. |

A later override of the same token replaces an earlier one. Guards, middleware and filters
passed as instances or functions are not classes and cannot be overridden.

### `compile()`

```text
compile(options?: CompileOptions): Promise<TestingModule>
```

Creates the application with `KneadFactory.create()`: providers are instantiated and the
`onModuleInit` and `onApplicationBootstrap` hooks run. It rejects with whatever error startup
throws (for example a `ConfigValidationError`). No server is started.

### `CompileOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `development` | `boolean` | `true` | The application's development flag. `true` puts error `detail` and `stack` in 500 responses and enables every development-only default, such as `GraphQLModule`'s `schema.graphql` file. Pass `false` to test production behavior. |
| `logger` | `Logger` | a new `MemoryLogger` | Passed as `KneadFactory.create()`'s `logger` option, so it is the `LOGGER` of every module, replacing `LoggingModule` and module-local `LOGGER` providers. An `overrideProvider(LOGGER)` still wins over it. |

## `OverrideBy`

```text
interface OverrideBy<T> {
  useValue(value: T): TestingModuleBuilder;
  useClass(cls: Type<T>): TestingModuleBuilder;
  useFactory(factory: () => T | Promise<T>): TestingModuleBuilder;
}
```

| Method | Replacement |
| --- | --- |
| `useValue(value)` | The value itself. |
| `useClass(cls)` | A singleton instance of `cls`, which may `inject()`. |
| `useFactory(factory)` | The factory's result. The factory runs inside the injection context, so it may `inject()`. An async factory works only for tokens registered as providers, not for guard, middleware or filter classes. |

## `TestingModule`

| Member | Type | Description |
| --- | --- | --- |
| `app` | `HttpApplication` | The created application. |
| `logger` | `Logger` | The logger passed to `KneadFactory.create()` (the `logger` option of `compile()`, or the default `MemoryLogger`). |
| `logs` | `readonly LogEntry[]` | The entries of `logger` when it is a `MemoryLogger` (`{ level, message, meta }`, unredacted), otherwise `[]`. |
| `get<T>(token: Token<T>): T` | method | A provider instance, as `app.get(token)`. |
| `createApp(options?: ListenOptions): Promise<TestApp>` | method | Starts the server with `{ port: 0, hostname: '127.0.0.1', ...options }` and returns a `TestApp`. Later calls, including concurrent ones, return the same `TestApp` (the server listens once) and ignore their options. A failed start is not cached. |
| `close(): Promise<void>` | method | Closes the application: stops the server if one is listening and runs the shutdown hooks. |

## `TestApp`

| Member | Type | Description |
| --- | --- | --- |
| `app` | `HttpApplication` | The listening application. |
| `url` | `URL` | The server's URL, such as `http://127.0.0.1:41723/`. |
| `request(method: string, path: string, init?: TestRequestInit): Promise<Response>` | method | Sends a request with `fetch()` to the server's origin followed by `path`. |
| `graphql<TData>(query: string, options?: GraphQLRequestOptions): Promise<GraphQLResult<TData>>` | method | POSTs `{ query, variables, operationName }` as JSON to `options.path` (default `'/graphql'`) and returns the parsed body plus `status` and `headers`. A response that is not JSON rejects with `Error: GraphQL response is not JSON (status <status>): <body text>` (the text capped at 1024 characters). |
| `graphqlSubscribe<TData>(query: string, options?: GraphQLSubscribeOptions): Promise<GraphQLSubscription<TData>>` | method | Opens a `graphql-transport-ws` connection (`ws:`, or `wss:` for an HTTPS server) and subscribes. |
| `close(): Promise<void>` | method | Closes the application, like `TestingModule.close()`. |

`path` (for `graphql()` and `graphqlSubscribe()`, `options.path`) must start with `/`, or the
call rejects with a `TypeError`: an absolute URL or a relative path is not accepted. It is appended
to the test server's origin, so `'//other.example/x'` is sent to the test server, never to the
host it seems to name.

### `TestRequestInit`

| Option | Type | Description |
| --- | --- | --- |
| `headers` | `Bun.HeadersInit` | Request headers. |
| `query` | `Record<string, string \| readonly string[]>` | Appended to the URL's query string; an array repeats the parameter. |
| `json` | `unknown` | Serialized with `JSON.stringify` as the body. Sets `Content-Type: application/json` unless `headers` has a content type. Wins over `body`. |
| `body` | `Bun.BodyInit` | A raw body. |
| `tls` | `{ rejectUnauthorized?: boolean }` | TLS options for an HTTPS test server. `rejectUnauthorized: false` accepts any certificate, such as a self-signed one: tests only, never in application code. |

## GraphQL client

`graphqlSubscribe()` sends `connection_init` with `connectionParams`, then, after
`connection_ack`, one `subscribe` message (id `'1'`) with the query, variables and operation
name. It answers `ping` with `pong`. The promise rejects with
`Error: WebSocket closed before connection_ack: <code> <reason>` when the socket closes before the
acknowledgment, and with `Error: WebSocket connection failed` when the connection fails. The
server may still be registering the subscription when the promise resolves, so publish events
until one arrives (see the [testing guide](/guide/testing/)).

### `GraphQLRequestOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `variables` | `Record<string, unknown>` | none | Operation variables. |
| `operationName` | `string` | none | The operation to run. |
| `headers` | `Bun.HeadersInit` | none | Request headers (for subscriptions, the upgrade request's headers). |
| `path` | `string` | `'/graphql'` | The endpoint path. |
| `tls` | `{ rejectUnauthorized?: boolean }` | none | TLS options for an HTTPS test server, passed to `fetch()` and, for subscriptions, to the `wss:` WebSocket. `rejectUnauthorized: false` accepts any certificate, such as a self-signed one: tests only, never in application code. |

### `GraphQLSubscribeOptions`

`GraphQLRequestOptions` plus:

| Option | Type | Description |
| --- | --- | --- |
| `connectionParams` | `Record<string, unknown>` | Sent as the `connection_init` payload, which the server's `subscriptions.onConnect` receives. |

### `GraphQLSubscription`

```text
interface GraphQLSubscription<TData> extends AsyncIterableIterator<GraphQLPayload<TData>> {
  close(): Promise<void>;
}
```

Yields the payload of each `next` message. A `complete` message or a normal close (code 1000)
ends the iteration; an `error` message is yielded as `{ errors }` and then ends it. A close with
any other code before that (a revoked socket, a server error) makes `next()` reject with
`Error: WebSocket closed: <code> <reason>`, after the payloads already received, and every later
`next()` rejects too. A frame that is not JSON makes it reject with
`Error: graphql-transport-ws message is not JSON: <text>` and closes the socket with 4400. `close()` sends `complete` (when the socket
is open and the subscription has not ended) and closes the socket with code 1000; `return()`,
called when a `for await` loop exits early, does the same.

### `GraphQLPayload`

```text
interface GraphQLPayload<TData = Record<string, unknown>> {
  data?: TData | null;
  errors?: GraphQLErrorJson[];
  extensions?: Record<string, unknown>;
}
```

### `GraphQLResult`

`GraphQLPayload<TData>` plus `status: number` (the HTTP status) and `headers: Headers`.

### `GraphQLErrorJson`

```text
interface GraphQLErrorJson {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}
```

One entry of `errors`. Knead puts the error code in `extensions.code` (for example
`BAD_USER_INPUT`, `FORBIDDEN`, `INTERNAL_SERVER_ERROR`).
