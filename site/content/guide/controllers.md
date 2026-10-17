---
title: Controllers
description: Declare routes with @Controller and the method decorators, and learn how Knead compiles them into Bun's router and turns return values into responses.
---

A controller is a class whose decorated methods handle HTTP requests. Each method decorator binds a
method to an HTTP method and a path. At `listen()`, Knead compiles every route of every module into
the `routes` table of `Bun.serve`, so matching is done by Bun's native router.

## Declaring a controller

Decorate the class with `@Controller(prefix)` and its handlers with a route decorator such as
`@Get(path)`. Every handler receives one argument, the request context `ctx`
(see [the request context](/guide/request-context/)).

<<< http/controllers.ts#controller title="cats.controller.ts"

List the controller in a module's `controllers`. Knead creates one instance per controller through
that module's injector, so `inject()` in field initializers works as in any provider (see
[dependency injection](/guide/dependency-injection/)).

<<< http/controllers.ts#module title="cats.module.ts"

`@Controller(prefix = '', options = {})` takes an optional path prefix and options that apply to
every route of the class:

| Option | Type | Description |
| --- | --- | --- |
| `middleware` | `MiddlewareRef[]` | Middleware for every route of the controller. See [middleware](/guide/middleware/). |
| `guards` | `GuardRef[]` | Guards for every route. See [guards](/guide/guards/). |
| `filters` | `FilterRef[]` | Exception filters for every route. See [exception filters](/guide/exception-filters/). |
| `meta` | `Record<PropertyKey, unknown>` | Route metadata, read as `ctx.meta`. See [route metadata](#route-metadata). |

A class listed in `controllers` must carry its own `@Controller()`. A subclass inherits the routes
of its parent class, but not the parent's `@Controller()`, so decorate the subclass too.
Otherwise `listen()` rejects with an `HttpConfigError` (see
[definition errors](#definition-errors)).

## Route decorators

| Decorator | Methods it handles |
| --- | --- |
| `@Get(path, options?)` | `GET`, and `HEAD` (Bun answers a `HEAD` request with the `GET` handler and drops the body) |
| `@Post(path, options?)` | `POST` |
| `@Put(path, options?)` | `PUT` |
| `@Patch(path, options?)` | `PATCH` |
| `@Delete(path, options?)` | `DELETE` |
| `@Head(path, options?)` | `HEAD` |
| `@Options(path, options?)` | `OPTIONS` |
| `@All(path, options?)` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` (so `HEAD` too, through `GET`) |

<<< http/controllers.ts#methods

A route decorator works only on public instance methods. On a `static` or `#private` method it
throws a `TypeError` when the class is defined, for example
`@Get() cannot decorate static or private method list.`

### Route options

The second argument takes everything a controller takes, plus validation schemas, a status and
post-validation guards:

| Option | Type | Description |
| --- | --- | --- |
| `middleware` | `MiddlewareRef[]` | Middleware for this route, after the controller's. |
| `guards` | `GuardRef[]` | Guards for this route, after the controller's. They run before validation. |
| `filters` | `FilterRef[]` | Exception filters for this route, tried before the controller's. |
| `meta` | `Record<PropertyKey, unknown>` | Route metadata, merged over the controller's. |
| `params` | `StandardSchemaV1` | Schema for `ctx.params`. See [validation](/guide/validation/). |
| `query` | `StandardSchemaV1` | Schema for `ctx.query`. |
| `headers` | `StandardSchemaV1` | Schema for `ctx.headers`. |
| `body` | `StandardSchemaV1` | Schema for the parsed body. |
| `authorize` | `GuardRef[]` | Guards that run after validation and see the validated input. |
| `status` | `number` | Status code of a successful response. Default `200`, or `204` when the handler returns `undefined`. |

## Paths and parameters

The route path is the controller prefix joined with the decorator's path. Empty segments are
dropped and the result has a leading slash and no trailing slash: `@Controller('/cats')` with
`@Get('/')` is `/cats`, and `@Controller('api/')` with `@Get('//cats/')` is `/api/cats`.
`@Controller()` with `@Get('/')` is the root path `/`.

Matching is exact and case-sensitive, and trailing slashes are strict: a request for `/cats/1/`
does not match `/cats/:id` and gets a 404.

### Path parameters

A segment that starts with `:` is a parameter. It matches one non-empty segment, and its value
arrives in `ctx.params` as a percent-decoded string: `/owners/a%20b/cats/7` gives
`{ ownerId: 'a b', catId: '7' }`. The parameter name runs to the next `/`, so in `/:file.json`
the parameter is named `file.json`; give a parameter its own segment.

<<< http/controllers.ts#params

The type of `ctx` is checked against the path: declaring
`Ctx<{ params: { id: string; postId: string } }>` on `@Get('/:id')` is a type error, because
`postId` is not in the path (`PathParams<'/users/:id'>` is `{ id: string }`). Parameters are always
strings; to receive a number, add a `params` schema that transforms it (see
[validation](/guide/validation/)).

### Wildcards

A `*` as the last segment matches the rest of the path, including nothing after the slash:
`/assets/*` matches `/assets/`, `/assets/logo.svg` and `/assets/css/site.css`, but not `/assets`.
The matched rest is not put in `ctx.params`; read it from the URL with `requestUrl(ctx.req)`.

<<< http/controllers.ts#wildcard

A `*` must be the whole last segment, and a path may contain only one. Bun's router matches
nothing else, so `listen()` rejects a `*` anywhere else (`/a/*/b`, `/files*`) with an
`HttpConfigError`, as it does a second `*`.

### Which route matches

The router picks the most specific route, whatever the order in which routes are declared or
modules are imported: an exact path such as `/owners/me` wins over `/owners/:ownerId`, and both win
over a wildcard. Two routes for the same method and path are a configuration error rather than an
ordering question (see [definition errors](#definition-errors)).

## How routes compile

`listen()` reads the metadata of every controller in every module and builds one handler per route
and method. Each handler runs the request through this chain:

1. The `allowedHosts` check (421 for an unknown `Host`; see [the server](/guide/server/)).
2. Global middleware (`APP_MIDDLEWARE` and `useGlobalMiddleware()`, highest priority first), then
   the module's `@ModuleMiddleware()`, the controller's middleware, and the route's middleware.
3. Guards: global (`APP_GUARD`, then `useGlobalGuards()`), then the controller's, then the route's.
   Anything but `true` is a 403.
4. Validation of `params`, `query`, `headers` and `body` against the route's schemas.
5. The route's `authorize` guards.
6. The handler, and the mapping of its return value to a `Response`.

An error thrown anywhere in the chain goes to the route's exception filters, then the controller's,
then the global ones, and finally to the default problem response (see [errors](/guide/errors/)).

The handlers are passed to `Bun.serve({ routes })`, keyed by path and method. Requests that no
route matches go to the `fetch` fallback, which runs the global middleware (so CORS and security
headers still apply) and then answers:

- **405 Method Not Allowed** when the path matches a route under another method. The `Allow`
  header lists the methods of every route pattern that matches the path, plus `HEAD` when `GET` is
  among them, for example `Allow: GET, DELETE, HEAD`. The detail is
  `PUT is not allowed on /cats/1`.
- **404 Not Found** otherwise, with the detail `No route for GET /nope`.

After `listen()`, `app.routes` lists the compiled routes as `RouteTableEntry` objects
(`{ method, path, handler }`, where `handler` is `ClassName.methodName`). An `@All()` route appears
once per method.

<<< http/reference.ts#bootstrap title="main.ts"

## Return values

Whatever the handler returns, or resolves to if it is async, becomes the response:

| Return value | Response |
| --- | --- |
| `undefined` | `204 No Content`, no body (or the `status` you set) |
| a `string` | `text/plain; charset=utf-8` |
| a `Blob` (including `Bun.file()`) | the bytes, with the Blob's own `type` as `Content-Type`, or `application/octet-stream` when it has none |
| a `ReadableStream`, `ArrayBuffer` or typed array | the bytes, as `application/octet-stream` |
| a `Response` | sent as is (see below) |
| anything else, including `null` | `JSON.stringify(value)` as `application/json; charset=utf-8` |

<<< http/responses.ts#values

A value that `JSON.stringify` cannot serialize, such as a `BigInt` or a function, is an error and
becomes a 500. A `Content-Type` you set on `ctx.res.headers` wins over the defaults in the table.

Every response built from a return value carries `X-Content-Type-Options: nosniff`, so a browser
does not guess a different type. A `Blob` keeps its own `type`; when you serve user-uploaded files,
set `Content-Disposition: attachment` on `ctx.res.headers` so they are downloaded instead of
rendered in your origin.

### Status codes and headers

Knead has no `@HttpCode()` or `@Header()` decorators. Set the status with the route's `status`
option, or per request with `ctx.res.status`, which wins over the option. Add headers with
`ctx.res.headers`, a standard `Headers` object.

<<< http/responses.ts#status

### Returning a Response

A `Response` you return is sent with its own status, headers and body: the `status` option and
`ctx.res.status` are ignored, and `nosniff` is not added. Headers on `ctx.res.headers` are copied
onto it only where the `Response` does not already have them, except `Set-Cookie`, which is
appended. When the `Response` has immutable headers (as `Response.redirect()` does), Knead copies
it to add them.

## Route metadata

Route metadata is a frozen object that guards and middleware read as `ctx.meta` (or
`ctx.route.meta`). Set it with the `meta` option of `@Controller()` or of a route decorator, or
create a decorator for it with `createRouteDecorator<T>(key)`. A decorator made this way works on
classes and methods and writes `{ [key]: value }`.

<<< http/route-meta.ts#decorator title="reports.controller.ts"

Metadata is merged in this order, later entries winning for the same key: the controller's `meta`
option, decorators on the class, the route's `meta` option, decorators on the method. See
[guards](/guide/guards/) for a role guard built on it.

## Definition errors

Knead checks route definitions when `listen()` compiles them. Each problem rejects `listen()` with
an `HttpConfigError` before the server binds, with a message that names the controller and method:

| Problem | Message |
| --- | --- |
| Two routes with the same method and path | `Duplicate route GET /health: HealthController.check and StatusController.status.` |
| Routes whose paths differ only in parameter names (under any methods) | `Routes /users/:id and /users/:userId differ only in parameter names; use the same names (UsersController.remove).` |
| More than one `*` in a path | `Route /files/*/x/* has more than one "*" wildcard (FilesController.files).` |
| A `*` that is not the whole last segment | `Route /a/*/b has a "*" that is not the whole last segment (MiddleController.middle); Bun only matches a trailing "/*".` |
| A class in `controllers` without its own `@Controller()` | `PlainController is listed in AppModule.controllers but is not decorated with @Controller().` |

The parameter name rule applies across methods: `GET /users/:id` and `DELETE /users/:userId` are
rejected, because Bun's router needs one name per path shape.

<<< http/route-conflicts.ts#names

Duplicates are detected across modules too: two controllers in different modules cannot both
declare `GET /health`.

See the [`@knead-js/http` reference](/packages/http/) for every decorator and type.
