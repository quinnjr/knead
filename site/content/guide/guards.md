---
title: Guards
description: Decide whether a request may reach its handler with guards, which pass only when they return exactly true.
---

A guard answers one question about a request: may it continue to the handler? Guards are where
authentication and authorization live. They run after all middleware and before validation and
the handler; [the request pipeline](/guide/middleware/#the-request-pipeline) gives the full order.

## The `Guard` interface

A guard is a class with a `canActivate(ctx)` method (the `Guard` interface), a plain object with
that method, or a function `(ctx) => boolean` (the `GuardFn` type). It returns a `boolean` or a
promise of one. The `GuardRef` type covers all three forms.

<<< http-pipeline/guards.ts#class title="session.guard.ts"

A guard class is constructed through dependency injection, like a middleware class: a provider
visible from the module is used when there is one, otherwise Knead constructs one instance per
module at `listen()` and runs its `onModuleInit` there and its `onModuleDestroy` at `close()`.

## Only `true` passes

A guard passes only when it returns, or resolves to, exactly `true`. Anything else is a denial:
`false`, but also `undefined` from a forgotten `return`, a user object, `1` or `'yes'`. This
fail-closed rule is deliberate: a bug in a guard denies access instead of granting it.

A denial is a `ForbiddenException`, so the client gets `403` with an RFC 9457 body:

```http
HTTP/1.1 403 Forbidden
content-type: application/problem+json; charset=utf-8
x-content-type-options: nosniff

{"type":"about:blank","title":"Forbidden","status":403,"instance":"/admin/stats"}
```

For any other status, throw an `HttpException` from the guard instead of returning `false`. The
`SessionGuard` above throws `UnauthorizedException`, which produces a `401` with the given
`detail` and the `www-authenticate` header. Both a denial and a thrown error go through the
route's [exception filters](/guide/exception-filters/) like any other error, and the request stops
there: validation and the handler never run.

## Scopes and order

Guards are attached at three levels, and run in this order, stopping at the first one that does
not pass:

1. **Global**: `APP_GUARD` providers (in module order), then `app.useGlobalGuards(...)` (in call
   order).
2. **Controller**: the `guards` option of `@Controller()`, then `@UseGuards()` on the class.
3. **Route**: the `guards` option of the route decorator, then `@UseGuards()` on the method.

Within one list, guards run left to right. The order matters when one guard depends on another:

<<< http-pipeline/guards.ts#controller title="admin.controller.ts"

`SessionGuard` runs before `rolesGuard`, so the user is in `ctx.state` by the time roles are
checked. Making `rolesGuard` global while `SessionGuard` stays on the controller would break this:
global guards run first, the role check would see no user, and every request with a `@Roles()`
requirement would be denied.

## Global guards

A global guard applies to every route and to every WebSocket upgrade. Register it with an
`APP_GUARD` multi-provider; its value is a `GuardRef`, and a class is resolved with the injector of
the module that provides the entry:

<<< http-pipeline/guards.ts#global title="app.module.ts"

`app.useGlobalGuards(...guards)` adds global guards from your bootstrap code (resolved with the
root module's injector) and throws an `HttpConfigError` once `listen()` has been called. Global
guards do not run for requests that match no route: those get a `404` or `405` directly.

## Guards that read route metadata

`createRouteDecorator(key)` makes a decorator that stores a value in the route's metadata. A guard
reads it from `ctx.meta` (the same object as `ctx.route.meta`, or an empty frozen object when there
is no matched route). Used on a class, the decorator applies to every route of the controller; on
a method it applies to that route and overrides a class value for the same key. The `meta` option
of `@Controller()` and of the route decorators sets metadata directly.

<<< http-pipeline/guards.ts#roles title="roles.ts"

The guard returns `true` when the route declares no roles, and otherwise requires the user to have
one of them. A missing user has no roles, so it is denied. GraphQL resolver contexts expose the
same `ctx.meta`, so one guard can protect routes and resolvers (see [GraphQL](/guide/graphql/)).
For permission checks beyond roles, see [authorization](/guide/authorization/).

## `authorize`: guards after validation

Guards run before validation, so they see the raw request: `ctx.params`, `ctx.query`,
`ctx.headers` and `ctx.json()` are unvalidated. A check that depends on validated or normalized
input belongs in the route's `authorize` option. Those guards run after the route's schemas have
passed, see the schema output in `ctx.params`, `ctx.query`, `ctx.headers` and `ctx.body`, and
follow the same rule: anything but `true` is a `403`.

<<< http-pipeline/guards.ts#authorize title="transfers.ts"

The schema trims and lowercases `account` before `ownsAccount` compares it, so `'  ADA '` matches
the user `ada`. Had the check been a plain guard, it would have compared the raw string. When
validation fails, the request is a `400` and the `authorize` guards do not run.

## Guards on WebSocket upgrades

Global guards also run on WebSocket upgrade requests, and so do a route's guards when a WebSocket
endpoint shares the path of a `GET` route (see [WebSockets](/guide/websockets/#guards)).
`ctx.upgrade` is `{ path }` on an upgrade request and `null` otherwise. Browsers cannot set an
`Authorization` header on a WebSocket, so a global guard that authenticates by header has to let
upgrades through and leave authentication to the endpoint's `upgrade()`:

<<< http-pipeline/guards.ts#upgrades title="bearer.guard.ts"

## Invalid guard references

Knead checks every guard reference at `listen()` with `assertGuardRef()`. A valid guard is an
object with a `canActivate()` function, a function, or a class with a `canActivate()` method on its
prototype. Anything else is an `HttpConfigError` that names where it was found, such as
`the guards of AdminController`, `APP_GUARD` or `useGlobalGuards()`. The two common causes are:

- `undefined`, usually from a circular import: the error says
  `undefined (often a circular import)`.
- A class whose `canActivate` is an arrow-function field (`canActivate = () => true`). Knead tells
  classes from functions by the prototype method, and a field does not create one. Write it as a
  method.

Libraries that accept a guard in their options can run the same check early, with their own
location in the message:

<<< http-pipeline/guards.ts#assert title="audit.module.ts"

## Testing guards

`TestingModuleBuilder.overrideGuard(Class)` replaces a guard class in a test module, for example
with `{ canActivate: () => true }`. See [testing](/guide/testing/).
