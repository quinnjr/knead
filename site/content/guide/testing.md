---
title: Testing
description: Boot real modules in tests, replace providers, guards, middleware and filters, and send requests to an ephemeral server with @knead-js/testing.
---

`@knead-js/testing` builds a real application from the modules you name, with any providers you
choose replaced, and can start it on a random local port so that tests send real HTTP, GraphQL
and WebSocket traffic. Tests run with `bun test`; the examples use `bun:test`.

```bash
bun add -d @knead-js/testing
```

`@knead-js/core` and `@knead-js/http` are peer dependencies, which your application already has.

## The application under test

The examples on this page test a small catalog module: a service, a controller with a guarded
route, a middleware that sets `x-request-id`, and an exception filter that turns a storage error
into a 503.

<<< testing/catalog.ts title="catalog.ts"

## Compile a testing module

`Test.createModule(metadata)` takes the same metadata as `@Module()` (`imports`, `providers`,
`controllers`, `exports`) for a root module it creates, and returns a `TestingModuleBuilder`.
`compile()` creates the application, exactly as `KneadFactory.create()` would: every provider is
instantiated and the `onModuleInit` and `onApplicationBootstrap` hooks run. `mod.get(token)`
returns a provider:

<<< testing/catalog.test-suite.ts#get title="catalog.test.ts"

Close every module you compile, so shutdown hooks run and servers stop. An `afterEach` hook does it
for every test in the file:

<<< testing/catalog.test-suite.ts#lifecycle title="catalog.test.ts"

`compile()` does not listen on a port. Tests that only call providers never open a socket.

## Send requests

`mod.createApp()` starts the application's server on `127.0.0.1` with a random free port and
returns a `TestApp`. `app.request(method, path, init)` sends a request to it with `fetch()` and
returns the `Response`:

<<< testing/catalog.test-suite.ts#request title="catalog.test.ts"

The `init` options:

- `query`: appended to the URL; an array value repeats the parameter (`tag=office&tag=garden`).
- `headers`: any `HeadersInit`.
- `json`: serialized with `JSON.stringify`, and `Content-Type: application/json` is set unless
  your `headers` already have a content type.
- `body`: a raw body (a string, `FormData`, `Blob` and so on), for other content types. `json`
  wins when both are given.
- `tls`: options for an HTTPS test server; see [HTTPS](#https).

Responses are the framework's real responses, so errors arrive as
[problem details](/guide/errors/):

<<< testing/catalog.test-suite.ts#not-found title="catalog.test.ts"

`createApp()` creates the server once: calling it again returns the same `TestApp` and ignores
the new options. It takes the same options as `listen()` (`ListenOptions` from `@knead-js/http`),
with `port: 0` and `hostname: '127.0.0.1'` as defaults. `app.url` is the server's URL.

> [!WARNING]
> `path` is resolved against the test server's URL with `new URL(path, app.url)`, so an absolute
> URL is followed to whatever host it names, headers included. Pass paths, never URLs built from
> untrusted input.

## Override providers

The builder replaces any provider before the application is created. `overrideProvider(token)`
picks the provider, and one of three methods supplies the replacement:

<<< testing/catalog.test-suite.ts#use-value title="catalog.test.ts"

`useValue(value)` uses the value as is. `useClass(cls)` constructs a class in its place, which may
`inject()` like any provider:

<<< testing/catalog.test-suite.ts#use-class title="catalog.test.ts"

`useFactory(factory)` calls a function, inside the injection context, and uses its result. For
providers, the factory may be async:

<<< testing/catalog.test-suite.ts#use-factory title="catalog.test.ts"

Each method returns the builder, so overrides chain. Overriding the same token twice keeps the
last replacement. A replacement applies to every module that registers the token, and an override
for a token that no module provides has no effect: `mod.get()` still fails with
`NoProviderError`. `multi: true` providers cannot be overridden.

A class with `#private` fields, like `ProductsService`, cannot be imitated by a plain object, so
these tests replace it with subclasses:

<<< testing/catalog.test-suite.ts#doubles title="catalog.test.ts"

## Override guards, middleware and filters

Guards, middleware and exception filters referenced by class (`@UseGuards(AdminGuard)`) are
constructed by the framework rather than registered as providers. `overrideGuard()`,
`overrideMiddleware()` and `overrideFilter()` replace them the same way:

<<< testing/catalog.test-suite.ts#guard title="catalog.test.ts"

<<< testing/catalog.test-suite.ts#middleware-filter title="catalog.test.ts"

The replacement is used wherever that class is referenced. These overrides accept `useValue`,
`useClass` and `useFactory`, but a factory must be synchronous: an async factory works only for a
token that is registered as a provider. An override matches a class reference only; a guard,
middleware or filter passed as an instance or a plain function cannot be overridden.

Remember that a guard passes only when it returns exactly `true`, so a replacement such as
`{ canActivate: () => true }` must return the boolean, not a truthy value. See
[guards](/guide/guards/).

## Test logs

`compile()` gives the application a `MemoryLogger` as its `LOGGER`, in every module, even when the
application imports `LoggingModule` or registers its own `LOGGER`. `mod.logs` lists every entry
logged so far, as `{ level, message, meta }` objects:

<<< testing/catalog.test-suite.ts#logs title="catalog.test.ts"

A `MemoryLogger` keeps entries exactly as logged, without redaction. It is for tests only.
Messages that the framework redacts before logging (such as unhandled request errors) are still
redacted, because the redaction happens before `LOGGER` is called.

A logger wrapped with `childLogger(inject(LOGGER), fields)` passes its fields as the first meta
item, so they appear in `mod.logs` too. See [child loggers](/guide/logging/).

To keep your own logger, pass it to `compile({ logger })`; `mod.logger` is the logger in use, and
`mod.logs` is empty unless it is a `MemoryLogger`:

<<< testing/catalog.test-suite.ts#logger title="catalog.test.ts"

An `overrideProvider(LOGGER)` replacement wins over both, but then `mod.logs` does not see the
entries, since `mod.logger` is still the testing logger.

## Development mode

`compile()` creates the application in development mode unless you pass `development: false`.
Development mode makes 500 responses carry the error's `detail` and `stack`, which helps when a
test fails, and logs errors in full:

<<< testing/catalog.test-suite.ts#development title="catalog.test.ts"

Development mode also switches on every development-only default in other packages. Pass
`development: false` to test what production clients get: masked errors, and for
[GraphQL](/guide/graphql/), no introspection or playground.

## GraphQL

`app.graphql(query, options)` POSTs an operation as JSON to `/graphql` and returns the parsed
body with the response's `status` and `headers`. `app.graphqlSubscribe(query, options)` opens a
`graphql-transport-ws` connection and returns an async iterator of results. Here is a module with
a query, a mutation and a subscription:

<<< testing/stock.graphql.ts title="stock.graphql.ts"

<<< testing/graphql.test-suite.ts#query title="stock.test.ts"

> [!WARNING]
> In development mode, `GraphQLModule` writes the schema to `schema.graphql` in the working
> directory while the application is created. Since `compile()` defaults to development mode, compile
> GraphQL tests with `{ development: false }` (or set `emitSchemaFile: false`) so that test runs
> do not write files.

Errors arrive in `res.errors`, with the code in `extensions.code`:

<<< testing/graphql.test-suite.ts#errors title="stock.test.ts"

Both methods take `variables`, `operationName`, `headers` and `path` (default `'/graphql'`).
`graphqlSubscribe()` also takes `connectionParams`, sent as the `connection_init` payload: that is
where a subscription sends its credentials, since browsers cannot set headers on a WebSocket.

### Subscriptions

`graphqlSubscribe()` resolves once the server acknowledges the connection (`connection_ack`). When
the server closes the socket first, it rejects with
`WebSocket closed before connection_ack: <code> <reason>`, so
`rejects.toThrow('4403')` asserts that `onConnect` refused the client. The
returned iterator yields each `next` payload, ends when the server completes the subscription,
and yields an `error` message as `{ errors }` before ending. `close()` sends `complete` and closes
the socket; breaking out of a `for await` loop does the same.

The server registers the subscription shortly after the acknowledgment, so an event published
right away can be missed. Trigger the event until the subscription yields, as `nextEvent` does
here:

<<< testing/graphql.test-suite.ts#subscription title="stock.test.ts"

This works with any pubsub engine, including `RedisPubSub`, where subscribing takes a round trip.

## HTTPS

To test an HTTPS server, pass `tls` to `createApp()` and accept the self-signed certificate per
request with `tls: { rejectUnauthorized: false }`:

<<< testing/tls.test-suite.ts#tls title="tls.test.ts"

`rejectUnauthorized: false` skips certificate verification. It belongs in tests only. A
throwaway certificate for `127.0.0.1` can be made with OpenSSL:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout key.pem -out cert.pem -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1
```

## Configuration in tests

`ConfigModule` reads `process.env` when the testing module compiles. To make tests independent of
the machine, override the configuration handle with a ready `Config`, or pass `values`. See
[configuration testing](/guide/configuration/).

The full API is on the [`@knead-js/testing` reference page](/packages/testing/).
