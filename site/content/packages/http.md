---
title: @knead-js/http
description: The HTTP layer of Knead, with controllers compiled into Bun's router, the request pipeline, RFC 9457 errors, TLS and WebSocket endpoints.
---

```bash
bun add @knead-js/core @knead-js/http
```

`@knead-js/core` is a peer dependency. The package requires Bun 1.4.3 or later.

`@knead-js/http` turns a module tree into a `Bun.serve` server. `KneadFactory.create()` bootstraps
the modules, and `listen()` compiles every controller route into Bun's native router, wraps each in
its middleware, guards, validation and exception filters, and binds the listener. The package also
holds the error types, the WebSocket endpoint registry, and the network and logging helpers the
other Knead packages build on.

Guides: [controllers](/guide/controllers/), [request context](/guide/request-context/),
[validation](/guide/validation/), [errors](/guide/errors/), [middleware](/guide/middleware/),
[guards](/guide/guards/), [exception filters](/guide/exception-filters/),
[the server](/guide/server/) and [WebSockets](/guide/websockets/).

## Application

<<< http/reference.ts#bootstrap title="main.ts"

### KneadFactory

`KneadFactory.create(root, options?)` returns `Promise<HttpApplication>`. It bootstraps the module
tree from `root` (a module class or dynamic module) with `HttpCoreModule` registered as a global
module, and resolves the `LOGGER`. The `onModuleInit` and `onApplicationBootstrap` hooks of the
bootstrapped providers run here.

`CreateApplicationOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `development` | `boolean` | `process.env.NODE_ENV === 'development'` | Development mode: error details in 5xx responses and logs, and the development `allowedHosts` default. Injectable as `HTTP_DEVELOPMENT`. |
| `logger` | `Logger` | the `LOGGER` of a global module such as `LoggingModule`, or a `ConsoleLogger` | Replaces the `LOGGER` of every module. |
| `overrides` | `Iterable<readonly [Token, Provider]>` | none | Provider overrides applied wherever the token is provided; a `LOGGER` entry here wins over `logger`. |

### HttpCoreModule

The global module `KneadFactory` registers. It provides and exports `WsRegistry` and `ErrorLog` to
every module. `HTTP_DEVELOPMENT` (the same token as core's `DEVELOPMENT`) is provided to every
module by the application context, from the `development` option. You never import it yourself.

### HttpApplication

`HttpApplication` is the application returned by `KneadFactory.create()`.

| Member | Description |
| --- | --- |
| `listen(options?)` | Compiles the routes, runs the lifecycle init hooks of middleware, guards and filters constructed for them, and binds the listener. Resolves to the Bun `Server`. Rejects with `HttpConfigError` for an invalid option or route definition, when called twice, or once `close()` has started. |
| `close(signal?)` | Graceful, idempotent shutdown: stops accepting connections, waits up to `shutdownTimeout` for in-flight requests, closes WebSockets with `1001`, then runs the shutdown hooks of the context. |
| `enableShutdownHooks(signals?, options?)` | Calls `close(signal)` on the first of `signals` (default `['SIGTERM', 'SIGINT']`), then exits with code 0, or 1 if shutdown failed. `{ exit: false }` keeps the process alive. Throws after `close()`. |
| `useGlobalMiddleware(middleware, priority = 0)` | Adds global middleware. Before `listen()` only: throws `HttpConfigError` once `listen()` has started (even while it is still initializing) or `close()` has. |
| `useGlobalGuards(...guards)` | Adds guards to every route, after `APP_GUARD` guards. Before `listen()` only, like `useGlobalMiddleware()`. |
| `useGlobalFilters(...filters)` | Adds exception filters tried after route, controller and `APP_FILTER` filters. Before `listen()` only, like `useGlobalMiddleware()`. |
| `reloadTls(tls)` | Replaces the TLS certificates: binds a new listener on the same port (`SO_REUSEPORT`) and lets the old one finish its in-flight requests (up to `shutdownTimeout`). Linux only, and only for an application listening with `tls`; throws `HttpConfigError` otherwise or while closing. |
| `get(token)` | Resolves a provider visible to the root module, or else from the first module that provides `token`. |
| `routes` | The compiled route table, `readonly RouteTableEntry[]` (empty before `listen()`). |
| `server` | The Bun `Server`. Throws `HttpConfigError` before `listen()`. |
| `url` | The listener's `URL`. |
| `port` | The listener's TCP port. |
| `redirectUrl` | The `URL` of the `redirectHttp` listener, or `undefined`. |
| `context` | The `ApplicationContext` from `@knead-js/core`. |
| `logger` | The application's `Logger`. |
| `development` | The resolved development flag. |

A `listen()` that failed to bind (for example, the port is in use) leaves nothing bound and can be
retried, but the context stays open: call `await app.close()` if you give up. A `listen()` that
failed because a lifecycle hook threw has closed the application. See [the server](/guide/server/).

### ListenOptions

`ListenOptions` is the argument of `app.listen()`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | `number` | `3000` | TCP port; `0` picks a free one. |
| `hostname` | `string` | `'0.0.0.0'` | Interface to bind. |
| `tls` | `TLSOptions \| TLSOptions[]` | none | Bun TLS options; serves HTTPS. |
| `redirectHttp` | `{ port: number; hostname?: string; host?: string }` | none | A second, plain-HTTP listener that answers `308` to the HTTPS URL. Requires `tls`. `host` is the canonical `host[:port]` for the `Location` header. |
| `trustProxy` | `TrustProxy` | `false` | Which proxies' `X-Forwarded-For` and `X-Forwarded-Proto` to believe for `ctx.ip` and `ctx.secure`. |
| `allowedHosts` | `readonly string[] \| false` | development: `localhost`, `127.0.0.1`, `[::1]` and the bound hostname (unless it is `0.0.0.0` or `::`); production: no check | Host names the server answers to; other `Host` headers get `421`. `false` disables the check. |
| `websocket` | `WsServerOptions` | see [`WsServerOptions`](#wsserveroptions) | Server-wide WebSocket limits. |
| `maxParams` | `number` | `1000` | Most query parameters (more is `400`) or urlencoded or multipart fields (more is `413`) per request. An integer of at least 1. |
| `maxRequestBodySize` | `number` | `1048576` (1 MiB) | Largest request body in bytes; Bun answers larger ones with `413`. An integer of at least 1. |
| `defaultCacheControl` | `string` | none | `Cache-Control` for every response that has none (including 404s, `421`s and rejected WebSocket upgrades), such as `'no-store'`. Must be a valid header value (no CR, LF or NUL, Latin-1 only). |
| `validation` | `ValidationOptions` | `{}` | See [`ValidationOptions`](#validationoptions). |
| `idleTimeout` | `number` | Bun's default (10 seconds) | Seconds a connection may be idle. An integer from 0 to 255. |
| `shutdownTimeout` | `number` | `10000` | Milliseconds `close()` waits for in-flight requests, and for a `listen()` still initializing. An integer of at least 0. |

The numeric options must be numbers within those ranges: a string (such as an unparsed environment
variable), `NaN` or `Infinity` is an `HttpConfigError` at `listen()`, before anything binds.

Both listeners run with Bun's development mode set to the application's development flag (Bun's
own default turns it on whenever `NODE_ENV` is not `'production'`, which renders an HTML page
with the error's message, stack and source). An error that escapes every Knead handler is logged
and answered with a masked `500` problem, never Bun's error page.

### redirectToHttps

`redirectToHttps(req, httpsPort, host?)` returns a `308` response to the same path and query on
HTTPS, with `Cache-Control: no-store` and `nosniff`. With `host` (a plain `host[:port]`), the
`Location` uses it and ignores the request's `Host`; a port in `host` overrides `httpsPort`, and an
invalid `host` throws `HttpConfigError`. Without it, the request's `Host` is used with its port
replaced by `httpsPort`, and a `Host` that is not a plain `host[:port]` gets `400 Invalid Host
header`. Port 443 is left out of the URL. The `redirectHttp` listener uses this function.

## Decorators

### Controllers and routes

| Decorator | Usage | Description |
| --- | --- | --- |
| `Controller` | `@Controller(prefix = '', options = {})` | Marks a class as a controller. `options` is a `ControllerOptions`. |
| `Get` | `@Get(path, options?)` | `GET` route (also answers `HEAD`). |
| `Post` | `@Post(path, options?)` | `POST` route. |
| `Put` | `@Put(path, options?)` | `PUT` route. |
| `Patch` | `@Patch(path, options?)` | `PATCH` route. |
| `Delete` | `@Delete(path, options?)` | `DELETE` route. |
| `Head` | `@Head(path, options?)` | `HEAD` route. |
| `Options` | `@Options(path, options?)` | `OPTIONS` route. |
| `All` | `@All(path, options?)` | One route per method for `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. |

`path` is a string and `options` a `RouteOptions`. A route decorator returns a
`RouteDecorator<P, O>` that types the handler's `ctx` from the path `P` and the options `O` (see
`RouteInput`), and throws a `TypeError` on a static or `#private` method. See
[controllers](/guide/controllers/).

### Pipeline decorators

| Decorator | Usage | Description |
| --- | --- | --- |
| `UseMiddleware` | `@UseMiddleware(...middleware)` | Adds middleware to a controller (class) or a route (method). See [middleware](/guide/middleware/). |
| `UseGuards` | `@UseGuards(...guards)` | Adds guards to a controller or a route. See [guards](/guide/guards/). |
| `UseFilters` | `@UseFilters(...filters)` | Adds exception filters to a controller or a route. See [exception filters](/guide/exception-filters/). |
| `Catch` | `@Catch(...errors)` | Restricts an exception filter class to errors that are instances of the given classes. Without it, a filter handles every error. |
| `ModuleMiddleware` | `@ModuleMiddleware(...middleware)` | On a module class: applies middleware to every controller declared in that module. |

The three `Use*` decorators return a `ClassOrMethodDecorator`, a decorator type that accepts both
a class and a method context. On a class the items are added at the controller level; on a method,
at the route level, after the ones given in the route decorator's options.

### createRouteDecorator

`createRouteDecorator<T>(key)` returns `(value: T) => ClassOrMethodDecorator`, a decorator that
writes `{ [key]: value }` into route metadata, read as `ctx.meta[key]`. On a class it applies to
every route of the controller; a method-level value wins over the class-level one. See
[route metadata](/guide/controllers/).

## Request context types

### Ctx

`Ctx<I extends CtxInput = {}>` is the request context (see
[request context](/guide/request-context/)):

| Member | Type |
| --- | --- |
| `req` | `Request` |
| `params` | `I['params']`, default `Record<string, string>` |
| `query` | `I['query']`, default `Record<string, string \| string[]>` |
| `body` | `I['body']`, default `unknown` |
| `headers` | `I['headers']`, default `Record<string, string>` (`null`-prototype, without `__proto__`, `constructor` or `prototype` keys) |
| `ip` | `string \| undefined` |
| `secure` | `boolean` |
| `route` | `RouteInfo \| null` |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` |
| `upgrade` | `UpgradeInfo \| null` |
| `state` | `CtxState & Record<PropertyKey, unknown>` |
| `res` | `ResponseDraft` |
| `server` | `Server<any>` |
| `json<T = unknown>()` | `Promise<T>`: the body parsed by `Content-Type`, memoized; the validated body once a `body` schema has passed |

| Type | Description |
| --- | --- |
| `CtxInput` | `{ params?: unknown; query?: unknown; body?: unknown; headers?: unknown }`, the type argument of `Ctx`. |
| `CtxState` | An empty interface to augment with `declare module '@knead-js/http'`, typing `ctx.state`. |
| `ResponseDraft` | `{ status: number \| undefined; readonly headers: Headers }`, the type of `ctx.res`. |
| `RouteInfo` | `{ method, path, controller, handler, meta }` of the matched route, all read-only. |
| `UpgradeInfo` | `{ readonly path: string }`: the WebSocket endpoint path of an upgrade request. |
| `HttpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'`. |
| `PathParams<P>` | The parameters of a path pattern as an object type: `PathParams<'/a/:id/b/:slug'>` is `{ id: string; slug: string }`. |
| `RouteInput<P, O>` | The `CtxInput` a route with path `P` and options `O` supplies: each schema's output type, or the defaults (`PathParams<P>`, string records, and `undefined` for the body). |
| `RouteDecorator<P, O>` | The method decorator type returned by the route decorators; it accepts a handler `(ctx: Ctx<RouteInput<P, O>>) => unknown`. |

### Route and controller options

`ControllerOptions`:

| Option | Type | Description |
| --- | --- | --- |
| `middleware` | `MiddlewareRef[]` | Middleware for every route. |
| `guards` | `GuardRef<any>[]` | Guards for every route. |
| `filters` | `FilterRef[]` | Exception filters for every route. |
| `meta` | `Record<PropertyKey, unknown>` | Route metadata for every route. |

`RouteOptions` extends `ControllerOptions` with:

| Option | Type | Description |
| --- | --- | --- |
| `params` | `StandardSchemaV1` | Validates and replaces `ctx.params`. |
| `query` | `StandardSchemaV1` | Validates and replaces `ctx.query`. |
| `headers` | `StandardSchemaV1` | Validates and replaces `ctx.headers`. |
| `body` | `StandardSchemaV1` | Validates the parsed body; sets `ctx.body` and the value of `ctx.json()`. |
| `authorize` | `GuardRef<any>[]` | Guards that run after validation. |
| `status` | `number` | Status of a successful response (default `200`, or `204` for `undefined`): an integer from 200 to 599, otherwise `listen()` throws `HttpConfigError`. With `204`, `205` or `304` the returned value is dropped. |

## Middleware, guards and filters

| Type | Definition |
| --- | --- |
| `Next` | `() => Promise<Response>`: calls the next layer. Calling it twice rejects. |
| `Middleware` | `{ use(ctx: Ctx, next: Next): Response \| Promise<Response> }` |
| `MiddlewareFn` | `(ctx: Ctx, next: Next) => Response \| Promise<Response>` |
| `MiddlewareRef` | `Type<Middleware> \| Middleware \| MiddlewareFn`: a class (constructed through the injector), an instance or a function. |
| `GlobalMiddleware` | `{ middleware: MiddlewareRef; priority?: number }`, the value of an `APP_MIDDLEWARE` provider. Higher priority runs first (outermost); the default is 0. |
| `Guard<C = Ctx>` | `{ canActivate(ctx: C): boolean \| Promise<boolean> }`. A guard passes only on exactly `true`; anything else is a 403. |
| `GuardFn<C = Ctx>` | `(ctx: C) => boolean \| Promise<boolean>` |
| `GuardRef<C = Ctx>` | `Type<Guard<C>> \| Guard<C> \| GuardFn<C>` |
| `ExceptionFilter<E = unknown>` | `{ catch(error: E, ctx: Ctx): Response \| undefined \| Promise<Response \| undefined> }`. Returning `undefined` declines the error and passes it on. |
| `FilterRef` | `Type<ExceptionFilter<any>> \| ExceptionFilter<any>` |
| `ErrorType` | `AbstractType<unknown>`: an error class, as passed to `@Catch()`. |

Middleware must return a `Response`; a layer that returns anything else is answered as a 500
error. `listen()` checks every middleware, guard and filter reference (global, module, controller
and route) and rejects with an `HttpConfigError` naming where it is listed for one that is
`undefined` (often a circular import), lacks its method, or is a class whose `use`, `canActivate`
or `catch` is an arrow-function field. A filter is never a plain function. If the error handling
itself fails (a filter's `@Catch()` metadata cannot be read, or an exception's extensions do not
serialize), the request still gets a problem response: extensions that do not serialize, such as a
`BigInt`, are dropped, and anything else is a masked `500` with the `instance`. See [middleware](/guide/middleware/), [guards](/guide/guards/) and
[exception filters](/guide/exception-filters/) for ordering and examples.

### assertGuardRef

`assertGuardRef(ref, where)` asserts that `ref` is a guard: an object with a `canActivate`
function, a function, or a class with `canActivate` on its prototype. Anything else (including
`undefined` from a circular import, or a class whose `canActivate` is an arrow-function field)
throws `HttpConfigError: Invalid guard in <where>: ...`. Knead runs this check on every guard at
`listen()`; packages that accept guards in their own options use it to fail the same way.

### resolveGuard

`resolveGuard(ref, injector, where = 'a guard list')` returns `Guard<any>`: it resolves a
`GuardRef` in a `ModuleInjector` (a class is constructed through the injector, a function is
adapted, an object is returned as is), after `assertGuardRef(ref, where)`. Used by
`@knead-js/graphql` for resolver guards.

## Tokens

| Token | Type | Description |
| --- | --- | --- |
| `APP_MIDDLEWARE` | `InjectionToken<GlobalMiddleware[]>` | Multi-provider: global middleware contributed by modules, for example `{ provide: APP_MIDDLEWARE, multi: true, useFactory: () => ({ middleware: inject(CorsMiddleware), priority: 1000 }) }`. |
| `APP_GUARD` | `InjectionToken<GuardRef[]>` | Multi-provider: guards applied to every route and WebSocket upgrade. |
| `APP_FILTER` | `InjectionToken<FilterRef[]>` | Multi-provider: exception filters tried after route and controller filters. |
| `HTTP_DEVELOPMENT` | `InjectionToken<boolean>` | The resolved development flag. The same token object as `DEVELOPMENT` from `@knead-js/core`. |

Class references in `APP_GUARD`, `APP_FILTER` and `APP_MIDDLEWARE` are resolved with the injector
of the module that provides them.

## Errors

See [errors](/guide/errors/) for the response format and production masking.

### HttpException

`new HttpException(status, detail?, options?)`, where `status` is an integer from 400 to 599
(otherwise a `RangeError`). Properties: `status`, `detail` (`string | undefined`), `type`,
`title`, `extensions`, `headers` (a `Headers`), plus `message` (the detail, or the title) and
`name` (the class name). `toProblem(instance?)` returns the `ProblemDetails` body.

`HttpExceptionOptions`:

| Option | Type | Default |
| --- | --- | --- |
| `type` | `string` | `'about:blank'` |
| `title` | `string` | `STATUS_TITLES[status]`, else the reason phrase from `node:http`'s `STATUS_CODES` (`502` is `Bad Gateway`), else `'Error'` |
| `extensions` | `Record<string, unknown>` | `{}` |
| `headers` | `Bun.HeadersInit` | none |
| `cause` | `unknown` | none |

### Subclasses

Each takes `(detail?, options?)`.

| Class | Status |
| --- | --- |
| `BadRequestException` | 400 |
| `UnauthorizedException` | 401 |
| `ForbiddenException` | 403 |
| `NotFoundException` | 404 |
| `MethodNotAllowedException` | 405 |
| `ConflictException` | 409 |
| `UnsupportedMediaTypeException` | 415 |
| `UnprocessableEntityException` | 422 |
| `TooManyRequestsException` | 429 |
| `InternalServerErrorException` | 500 |
| `ServiceUnavailableException` | 503 |

### ValidationException

`ValidationException` is thrown when a route's schemas reject a request:
`new ValidationException(issues)` is a `BadRequestException` with the detail
`Request validation failed`, the extension `issues`, and a read-only `issues` property. The
validation types:

| Type | Definition |
| --- | --- |
| `ValidationSource` | `'params' \| 'query' \| 'headers' \| 'body'` |
| `ValidationIssue` | `{ source: ValidationSource; message: string; path: string[] }` |
| `ValidationOptions` | `{ redactIssueMessages?: boolean }` (see below) |

#### ValidationOptions

`listen({ validation })`. `redactIssueMessages` (default `false`) replaces the messages of `params`,
`query` and `body` issues with `Invalid value`. Issues from `headers` always have the message
`Invalid header value`. See [validation](/guide/validation/).

### HttpConfigError

A `KneadError` (from `@knead-js/core`) for configuration problems found while the application is
bootstrapped, compiled or started: invalid route definitions, invalid guards, invalid `listen()`
options, WebSocket endpoints registered after `listen()`, and calling `listen()` twice.

### Problem helpers

| Export | Description |
| --- | --- |
| `ProblemDetails` | The RFC 9457 body: `{ type: string; title: string; status: number; detail?: string; instance?: string; [extension: string]: unknown }`. |
| `problemResponse(problem, headers?)` | A `Response` with `problem` as JSON, its `status`, `Content-Type: application/problem+json; charset=utf-8` and `X-Content-Type-Options: nosniff`. |
| `STATUS_TITLES` | `Readonly<Record<number, string>>`: titles for 400, 401, 403, 404, 405, 409, 413, 415, 421, 422, 429, 500 and 503 (RFC 9110 names). Other statuses take their title from `node:http`'s `STATUS_CODES`. |
| `defaultErrorResponse(error, ctx, logger, development)` | The response Knead sends for an error that no filter handled, with production masking and 5xx logging. `ctx` needs only `req`. |

## Responses

`withHeaders(res, headers, overwrite = true)` adds `headers` to a `Response` and returns it. When
the response's headers are immutable (as on `Response.redirect()`), it returns a copy with the
headers added. `Set-Cookie` values are appended; with `overwrite` false, headers the response
already has are kept.

`isHeaderValue(value)` is true when `value` can be sent as a header value: no CR, LF or NUL and
Latin-1 only. Knead uses it to validate header values given as options at bootstrap.

<<< http/reference.ts#helpers

`requestUrl(req)` returns the request's URL as a `URL`. A request whose `Host` header does not form
a valid URL has a relative `req.url` in Bun; it is resolved against `http://host.invalid` instead
of throwing.

`DEFAULT_MAX_PARAMS` is `1000`, the default of `listen({ maxParams })`.

## Routes table

| Type | Description |
| --- | --- |
| `RouteTableEntry` | `{ readonly method: HttpMethod; readonly path: string; readonly handler: string }`, one entry of `app.routes`. `handler` is `ClassName.methodName`. |
| `BunHandler` | `(req: Request, server: Server<any>) => Promise<Response \| undefined>`: the shape of each compiled route handler and of the fallback passed to `Bun.serve`. It resolves to `undefined` once a WebSocket upgrade succeeded. |

## Metadata keys

The decorators store their data under these `MetadataKey`s (all `knead:`-prefixed), readable with
`getMetadata()`, `getOwnMetadata()` and `getMethodMetadata()` from `@knead-js/core`. Use them to
build tooling, such as a route listing; the decorators are the supported way to write them.

| Key | Type | Written by |
| --- | --- | --- |
| `CONTROLLER` | `MetadataKey<ControllerDefinition>` | `@Controller()`; `ControllerDefinition` is `{ prefix: string; options: ControllerOptions }`. |
| `ROUTES` | `MetadataKey<RouteDefinition[]>` | Route decorators; `RouteDefinition` is `{ methods: HttpMethod[]; path: string; handler: string \| symbol; options: RouteOptions }`. |
| `GUARDS` | `MetadataKey<GuardRef<any>[]>` | `@UseGuards()` |
| `MIDDLEWARE` | `MetadataKey<MiddlewareRef[]>` | `@UseMiddleware()` |
| `FILTERS` | `MetadataKey<FilterRef[]>` | `@UseFilters()` |
| `ROUTE_META` | `MetadataKey<Record<PropertyKey, unknown>>` | `createRouteDecorator()` decorators |
| `CATCH` | `MetadataKey<ErrorType[]>` | `@Catch()` |
| `MODULE_MIDDLEWARE` | `MetadataKey<MiddlewareRef[]>` | `@ModuleMiddleware()` |

`ROUTES` is inherited by subclasses; `CONTROLLER` must be the class's own.

## WebSockets

See [WebSockets](/guide/websockets/) for endpoints, origin checks, limits and revocation.

### WsRegistry

The injectable registry of WebSocket endpoints (Bun allows one WebSocket handler per server, so
modules register endpoints here). Inject it with `inject(WsRegistry)`.

| Member | Description |
| --- | --- |
| `register(path, endpoint, options?)` | Registers a `WsEndpoint` at an exact path (no `:` or `*` segments). Upgrades to that path reach it even when a parametric or wildcard `GET` route (`/ws/:id`, `/*`) covers the path. Throws `HttpConfigError` for a duplicate path, a registration after `listen()`, or invalid options. |
| `closeWhere(predicate, code = 1008, reason = 'Connection revoked')` | Closes every open socket for which the predicate returns a truthy value and returns how many it closed. Also applied to sockets still upgrading when they open (kept up to 30 seconds, at most `maxPendingRevocations`). Write predicates against `ws.data` only. |
| `closeAll(code = 1001, reason = 'Server shutting down')` | Closes every open socket. |
| `openSockets` | The number of open sockets. |
| `maxPendingRevocations` | The `websocket.maxPendingRevocations` limit in effect. |
| `get(path)` | The endpoint registered at `path`, or `undefined`. |
| `entries()` | An iterator of `[path, endpoint]` pairs. |
| `handler()` | The Bun `WebSocketHandler` passed to `Bun.serve`, with the configured limits. Used by `listen()`. |

### WebSocket types

| Type | Definition |
| --- | --- |
| `WsEndpoint<D = unknown>` | `{ upgrade(ctx: Ctx): D \| false \| Promise<D \| false>; open?(ws); message?(ws, message: string \| Buffer); close?(ws, code, reason); drain?(ws) }`. `upgrade()` returns the socket data to accept, or `false` to answer `403`; throw an `HttpException` for another status. Errors thrown by the event hooks are logged; one thrown by `open` also closes the socket with `1011`. `message`, `close` and `drain` run only for sockets whose `open` ran. |
| `WsSocket` | `ServerWebSocket<WsData>`, the socket the hooks receive. |
| `WsData` | `{ readonly endpoint: string; readonly data: unknown; readonly ip?: string \| undefined }`: `data` is what `upgrade()` returned, `ip` the upgrade's `ctx.ip`. |
| `WsMessageRate` | `{ limit: number; windowMs: number }`: a token bucket of `limit` messages refilled over `windowMs`. |
| `WsEndpointOptions` | Per-endpoint options, below. |
| `WsServerOptions` | Server-wide limits, below. |

`WsEndpointOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedOrigins` | `readonly string[] \| '*'` | same origin only | Origins allowed besides the request's own, each exactly `scheme://host[:port]` (no path, default port or wildcard); `'*'` disables the check. Upgrades without an `Origin` header are allowed. |
| `messageRate` | `WsMessageRate \| false` | the server's `messageRate` | Per-socket rate; exceeding it closes the socket with `1008`. |
| `maxConnectionLifetime` | `number` | no limit | Milliseconds after which a socket is closed with `4408`, at most `2 ** 31 - 1`. |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | none | Route-style metadata for the upgrade's `ctx.meta`, copied and frozen at `register()`. |

#### WsServerOptions

`listen({ websocket })`. The defaults are in `WS_DEFAULTS`, a frozen object; an option passed as
`undefined` keeps its default. The connection slot of an upgrade whose socket has not opened after
30 seconds is given back; a socket that opens later takes a slot again, or is closed with `1013`
when none is free.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxPayloadLength` | `number` | `262144` (256 KiB) | Largest message in bytes; a larger one drops the connection. |
| `backpressureLimit` | `number` | `1048576` (1 MiB) | Bytes buffered for a slow reader before backpressure applies. |
| `closeOnBackpressureLimit` | `boolean` | `true` | Close a socket over `backpressureLimit`. A non-boolean is an `HttpConfigError`. |
| `idleTimeout` | `number` | `120` | Seconds without traffic before a socket is closed, 0 to 960. |
| `maxConnectionsPerIp` | `number \| false` | `100` | Open sockets per client IP; more upgrades get `429`. |
| `ipv6Subnet` | `number` | `64` | IPv6 prefix length the per-IP limit groups by, 1 to 128. |
| `maxConnections` | `number` | no limit | Open sockets in total; more upgrades get `503`. |
| `messageRate` | `WsMessageRate \| false` | `{ limit: 100, windowMs: 10000 }` | Default per-socket message rate. |
| `maxPendingRevocations` | `number` | `10000` | `closeWhere()` predicates kept for sockets still upgrading. |

### originAllowed

`originAllowed(origin, host, secure, allowed?)` returns whether a WebSocket upgrade's `Origin` may
connect: when `origin` is `null` (no header, not a browser), when `allowed` is `'*'` or lists the
origin, or when it is the request's own origin (scheme from `secure`, host and port from `host`,
default ports normalized). `Origin: null` is rejected. Exported for transports that check origins
themselves.

## Network helpers

| Export | Description |
| --- | --- |
| `TrustProxy` | `false \| number \| readonly string[]`: ignore forwarding headers, trust that many proxy hops, or trust the listed CIDRs. A CIDR is an address with an optional `/` and 1 to 3 decimal digits (`10.0.0.0/8`); any other entry (`10.0.0.0/`, `10.0.0.0/0x8`, `10.0.0.0/8/x`, a non-string) is an `HttpConfigError`. See [the server](/guide/server/). |
| `parseIp(ip)` | The address as 4 bytes (IPv4, including IPv4-mapped IPv6) or 16 bytes (IPv6) in a `Uint8Array`, or `undefined` when it is not an IP address. Zone ids are ignored. |
| `formatIp(bytes)` | Dotted IPv4 for 4 bytes; RFC 5952 IPv6 (lowercase, longest zero run compressed) for 16. |
| `normalizeIp(ip)` | The canonical text form of an address (as `ctx.ip` is): IPv4-mapped IPv6 becomes IPv4, IPv6 is compressed. Unparseable input is returned unchanged. |
| `maskIp(ip, prefix)` | A per-client key: IPv4 as is, IPv6 masked to `prefix` bits and written `network/prefix`. Throws a `RangeError` unless `prefix` is an integer from 0 to 128. |
| `isIpv6Prefix(prefix)` | Whether `prefix` is an integer from 0 to 128. |
| `isLoopbackHostname(hostname)` | Whether a URL hostname is loopback: `localhost`, `localhost.`, `127.0.0.0/8` or `::1` (also IPv4-mapped, with or without brackets). |
| `plaintextRedisHost(url)` | The `host[:port]` of a `redis://` or `valkey://` URL to a host that is not loopback, or `undefined` (TLS URLs, Unix sockets, loopback hosts and unparseable URLs). Used to warn about unencrypted remote Redis connections. |
| `defaultRedisUrl()` | `process.env.REDIS_URL`, else `process.env.VALKEY_URL`, else `undefined`: the URL `Bun.redis` connects to without an explicit one. |

`parseIp()`, `isLoopbackHostname()`, `plaintextRedisHost()` and `defaultRedisUrl()` are
re-exported from `@knead-js/core`.

## Logging

These are re-exported from `@knead-js/core` as the same objects, so code that imports them from
either package shares one `LOGGER` token. See [logging](/guide/logging/) and the
[`@knead-js/core` reference](/packages/core/).

| Export | Description |
| --- | --- |
| `LOGGER` | `InjectionToken<Logger>`: the application logger. |
| `Logger` | `{ debug, info, warn, error }`, each `(message: string, ...meta: unknown[]) => void`. |
| `ConsoleLogger` | The default `Logger`: prints to the console with a `[knead]` prefix (`new ConsoleLogger(prefix)` changes it), with credentials redacted and control characters escaped. |
| `MemoryLogger` | A `Logger` that records `entries` (and `clear()`s them), unredacted. For tests only. |
| `LogEntry` | `{ level: LogLevel; message: string; meta: unknown[] }`, a `MemoryLogger` entry. |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` |
| `redactCredentials(text)` | Replaces URL userinfo, secret `key=value` values and `Bearer`/`Basic` credentials in a string with `***`. |
| `redactValue(value)` | A copy of a value with credentials redacted in strings, sensitive keys (`authorization`, `cookie`, `password`, `token`, ...) replaced by `***`, walked 4 levels deep. |
| `logValue(value)` | A client-controlled value made safe to interpolate into a log message: capped at `MAX_LOGGED_VALUE_LENGTH` characters and with control characters escaped. |
| `MAX_LOGGED_VALUE_LENGTH` | `1024` |

### Error logging

| Export | Description |
| --- | --- |
| `logError(options, message, error, level = 'error')` | Logs `error` under a new correlation id and returns the id. In development, the full error is logged, redacted; otherwise only `Name: message` (`summarizeError()`). `options` is an `ErrorLogOptions`. |
| `ErrorLogOptions` | `{ readonly logger: Logger; readonly development: boolean }` |
| `ErrorLog` | Injectable `logError()` with the application's `LOGGER` and `HTTP_DEVELOPMENT`: `inject(ErrorLog).log(message, error, level?)` returns the correlation id. |
| `summarizeError(error)` | `Name: message` with the message redacted, capped at `LOGGED_MESSAGE_LENGTH` characters, and control characters escaped. No stack, cause or properties. |
| `LOGGED_MESSAGE_LENGTH` | `500` |

## Runtime version

| Export | Description |
| --- | --- |
| `MIN_BUN_VERSION` | `'1.4.3'`, the oldest supported Bun. It fixes CVE-2026-48618 (TLS hostname matching) and request smuggling through bare-LF chunked bodies, among other server bugs. |
| `compareVersions(a, b)` | Compares two `major.minor.patch` versions, ignoring pre-release and build suffixes: negative when `a` is older, `0` when equal, positive when newer. |
| `checkBunVersion(logger, version = Bun.version)` | Returns `true` when `version` is at least `MIN_BUN_VERSION`; otherwise logs a warning (once per process) and returns `false`. `listen()` calls it. |
