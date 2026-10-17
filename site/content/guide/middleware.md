---
title: Middleware
description: Wrap requests in middleware layers, choose their scope and priority, and see the exact order in which Knead runs middleware, guards, validation, the handler and exception filters.
---

Middleware wraps the rest of the request pipeline. A middleware receives the request context and a
`next()` function, and returns a `Response`: usually the one `next()` resolves to, sometimes
decorated with extra headers, and sometimes one of its own that ends the request early.

## The request pipeline

Every request to a route runs through these steps, in this order:

1. **Host check.** When `allowedHosts` is in effect, a request whose `Host` header names another
   host is answered with `421 Misdirected Request` before anything else runs (see
   [the server guide](/guide/server/#allowed-hosts)).
2. **Global middleware**, highest `priority` first. Middleware with equal priority runs in
   registration order: `APP_MIDDLEWARE` providers (in module order) before
   `app.useGlobalMiddleware()` calls (in call order).
3. **Module middleware**: `@ModuleMiddleware()` on the module that declares the controller.
4. **Controller middleware**: the `middleware` option of `@Controller()`, then
   `@UseMiddleware()` on the class.
5. **Route middleware**: the `middleware` option of the route decorator (`@Get()`, `@Post()`, ...),
   then `@UseMiddleware()` on the method.
6. **Guards**: global guards (`APP_GUARD` providers, then `app.useGlobalGuards()`), then the
   controller's guards (`guards` option, then `@UseGuards()`), then the route's (`guards` option,
   then `@UseGuards()`). See [guards](/guide/guards/).
7. **Validation** of the route's `params`, `query`, `headers` and `body` schemas, in that order.
   Every issue is collected, then a failure is one 400 response (see
   [validation](/guide/validation/)).
8. **`authorize` guards** of the route, which see the validated values.
9. **The handler.** Its return value becomes the response (see [controllers](/guide/controllers/)).
10. On the way back out, each middleware gets the response from its `next()`, in reverse order.

When any step from 2 to 9 throws, the error goes to the route's
[exception filters](/guide/exception-filters/) (route, then controller, then global) and finally
to the default problem response. The error never escapes as an exception: it becomes a
`Response` at the layer that threw, and the middleware outside that layer receives it from
`next()` like any other response. Last, when `listen({ defaultCacheControl })` is set, the value
is added to a final response that has no `Cache-Control` header.

A request that matches no route runs only the global middleware, then gets a `404` (or a `405`
with an `Allow` header when the path exists with other methods), and only global exception filters
see that error. WebSocket upgrades take a related path, described in
[WebSockets](/guide/websockets/#how-an-upgrade-is-processed).

## Writing middleware

A middleware is a class with a `use(ctx, next)` method (the `Middleware` interface), a plain
object with that method, or a function `(ctx, next) => Response` (the `MiddlewareFn` type). All
three may be `async`.

<<< http-pipeline/middleware.ts#class title="request-timer.middleware.ts"

<<< http-pipeline/middleware.ts#function title="request-id.middleware.ts"

`withHeaders(res, headers)` adds headers to a response. It appends `set-cookie` values, overwrites
other headers by default (pass `false` as the third argument to keep values the response already
has), and copies the response when its headers are immutable, so always use the `Response` it
returns. Values you put in `ctx.state` are visible to every later middleware, guard and the
handler of the same request.

A middleware class is constructed through dependency injection, so it can `inject()` services.
When the class is also registered as a provider visible from the module, that provider is used;
otherwise Knead constructs one instance per module. Instances that Knead constructs this way are
built at `listen()`, receive `onModuleInit` there, and receive `onModuleDestroy` at `close()` (see
[lifecycle](/guide/lifecycle/)). A failing `onModuleInit` makes `listen()` reject.

## Short-circuiting

A middleware that returns without calling `next()` ends the request: nothing inside it runs, not
even the handler's guards.

<<< http-pipeline/middleware.ts#short-circuit title="maintenance.middleware.ts"

A middleware can also throw. A thrown `HttpException` becomes an
`application/problem+json` response through the exception filters, exactly as if the handler had
thrown it, so returning a `Response` is for answers you want to build yourself and throwing is for
errors:

<<< http-pipeline/middleware.ts#throw title="require-json.middleware.ts"

## The `next()` contract

- `next()` returns a promise of the inner response. It does not reject when an inner layer or the
  handler throws: that error has already become a response (a 415, a 500, ...). Middleware cannot
  catch a handler's error with `try`/`catch` around `next()`; use an
  [exception filter](/guide/exception-filters/) for that, and inspect `res.status` if you only
  need to know about it.
- Call `next()` at most once. A second call rejects with
  `next() called multiple times in <ClassName>`, which turns into a 500.
- Return a `Response`. Any other value is a `TypeError`
  (`<ClassName> did not return a Response`), answered with a 500.

In both error cases, outside development the 500 body carries no detail; the message is in the
server log under the response's `correlationId`.

## Scopes

Middleware can apply to a route, a controller, every controller of a module, or the whole
application.

<<< http-pipeline/middleware.ts#scopes title="reports.module.ts"

Here `GET /reports/live` runs `requestId` (module), then `RequestTimer` (controller), then
`noStore` (route). Module middleware applies to the controllers listed in that module's own
`controllers`; it does not reach controllers of the modules it imports.

## Global middleware

Global middleware runs on every request, including requests that match no route. Register it
with an `APP_MIDDLEWARE` multi-provider, whose value is a `GlobalMiddleware`
(`{ middleware, priority? }`), or imperatively before `listen()`:

<<< http-pipeline/middleware.ts#global title="app.module.ts"

A class given as `middleware` is resolved with the injector of the module that provides the
`APP_MIDDLEWARE` entry, so its `inject()` calls see that module's providers.
`app.useGlobalMiddleware(middleware, priority = 0)` does the same from your bootstrap code, using
the root module's injector, and throws an `HttpConfigError` once `listen()` has been called.

### Priorities

Higher priority runs first, which makes it the outermost layer: it sees the request before the
others and the response after them. The default is `0`. Knead's own modules use:

| Module | Middleware | Priority |
| --- | --- | --- |
| `SecurityHeadersModule` | `SecurityHeadersMiddleware` | `1100` |
| `CorsModule` | `CorsMiddleware` | `1000` |
| `RateLimitModule` | `RateLimitMiddleware` | `900` |

So security headers wrap CORS, which wraps rate limiting: CORS preflight responses and `429`
responses still get the security headers. Give your own middleware a priority below `900` (the
example uses `500`) when its responses should get those headers and be rate limited, and above
`1100` only when it must run before all of them.

> [!NOTE]
> All middleware, at every scope, runs before every guard, so no middleware sees what a guard
> stores in `ctx.state` (such as the signed-in user) on its way in. Logic that needs the user
> belongs in a guard that runs after the authenticating one, or in the handler. This is also why
> `RateLimitMiddleware` keys on the request alone; `@knead-js/rate-limit` has a `RateLimitGuard`
> for limits per user.

## Testing middleware

`TestingModuleBuilder.overrideMiddleware(Class)` replaces a middleware class in a test module. See
[testing](/guide/testing/).
