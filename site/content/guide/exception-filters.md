---
title: Exception filters
description: Turn errors thrown anywhere in the request pipeline into responses of your choice with exception filters, and know what happens when no filter handles them.
---

Errors thrown by middleware, guards, validation or a handler become responses. By default that
is Knead's RFC 9457 problem response (see [errors](/guide/errors/)). An exception filter lets you
answer specific errors differently: map a domain error to a `404`, render an HTML error page,
or report errors to a tracker.

## The `ExceptionFilter` interface

A filter is a class or object with a `catch(error, ctx)` method that returns a `Response`, or
`undefined` to decline the error. The method may be `async`. `ExceptionFilter<E>` types the error
parameter; the `FilterRef` type covers a filter class and a filter object. Unlike middleware and
guards, a plain function is not a filter.

`@Catch(...errorClasses)` restricts a filter class to errors that are `instanceof` one of the
listed classes, so subclasses match too. A filter without `@Catch()`, including every filter
object, is tried for every error.

<<< http-pipeline/filters.ts#catch title="account-not-found.filter.ts"

A `NotFoundException` builds the problem body here (`toProblem(instance)`), and `problemResponse()`
sends it with `content-type: application/problem+json; charset=utf-8` and
`x-content-type-options: nosniff`. A request for an unknown account gets:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Account acc_2 does not exist",
  "instance": "/accounts/acc_2"
}
```

Filter classes are constructed through dependency injection, like middleware and guards: a
provider visible from the module is used when there is one, otherwise Knead constructs one
instance per module at `listen()` and runs its `onModuleInit` there and its `onModuleDestroy` at
`close()`.

## Scopes and matching

Filters are attached at three levels:

| Scope | How |
| --- | --- |
| Route | The `filters` option of the route decorator, then `@UseFilters()` on the method. |
| Controller | The `filters` option of `@Controller()`, then `@UseFilters()` on the class. |
| Global | `APP_FILTER` multi-providers (in module order), then `app.useGlobalFilters(...)` (in call order). |

When an error reaches the filters, Knead tries them in exactly that order, route filters first,
and the first filter that handles the error wins:

1. A filter whose `@Catch()` classes do not match the error is skipped.
2. A filter that returns a `Response` ends the search, and that response is sent.
3. A filter that returns `undefined` declines, and the next filter is tried.
4. When no filter handles the error, the default problem response is sent.

<<< http-pipeline/filters.ts#scopes title="accounts.controller.ts"

`GET /accounts/acc_1/statement` throws an `AccountNotFoundError`, but its route filter comes
first and answers `503` with `Retry-After: 30`, so the controller's `AccountNotFoundFilter` is
never consulted.

The filters of the matched route handle errors from every step of its pipeline, including global
middleware. A request that matches no route has only global filters, which see its
`NotFoundException` or `MethodNotAllowedException`. `app.useGlobalFilters()` throws an
`HttpConfigError` once `listen()` has been called.

## Declining an error

A filter that returns `undefined` lets the error continue, which suits global filters that observe
errors without answering them:

<<< http-pipeline/filters.ts#decline title="app.module.ts"

`ReportUnexpected` reports 5xx and unknown errors, then declines, so the client still gets the
default response (a masked `500` in production). Since filters run route first, errors that a
route or controller filter already answered never reach it.

## When a filter fails

A filter that throws, or that returns something that is neither a `Response` nor `undefined`,
does not get a second chance, and neither do the filters after it. Knead logs the problem and
sends the default problem response for the **original** error:

- A throwing filter is logged at error level as `Exception filter <ClassName> threw`, with a
  correlation id, through the same redacting error log as other server errors.
- A filter returning another value is logged as
  `Exception filter <ClassName> did not return a Response`.

> [!WARNING]
> Throwing an `HttpException` from a filter does not convert the error. If an
> `AccountNotFoundFilter` threw `new NotFoundException()`, the client would get the default
> response for the `AccountNotFoundError`, a `500`. Return the response instead, as the example
> above does with `problemResponse()`.

## The default response

When no filter handles an error, `defaultErrorResponse(error, ctx, logger, development)` (also
exported, for filters and transports that want the same mapping) builds it:

- An `HttpException` below 500 becomes a problem response with its `type`, `title`, `status`,
  `detail`, extensions and headers.
- An `HttpException` of 500 or above is logged under a correlation id. Outside development the
  body has only `type`, `title`, `status`, `instance` and `correlationId`: the detail and
  extensions are dropped, while headers such as `Retry-After` are kept.
- Any other error is logged under a correlation id and answered with a `500`
  `Internal Server Error`. Only in development does the body include the error's `detail` and
  `stack`, with credentials redacted.

Development mode is `KneadFactory.create(root, { development })`, which defaults to
`NODE_ENV === 'development'` (see [the server guide](/guide/server/#creating-the-application)).
The [errors guide](/guide/errors/) covers the problem format and the exception classes in full.

## Testing filters

`TestingModuleBuilder.overrideFilter(Class)` replaces a filter class in a test module. See
[testing](/guide/testing/).
