# @hpmws/http

HTTP(S) for hpmws: `@Controller` and `@Get`/`@Post`/… compiled into Bun's native router; schema-typed `Ctx` (Standard Schema); middleware, guards and exception filters; RFC 9457 errors; TLS, HTTP→HTTPS redirect (`redirectHttp` requires `tls`), graceful shutdown and a WebSocket endpoint registry (endpoint paths must be exact). An upgrade request passes through global middleware and global guards (`APP_GUARD` and `useGlobalGuards()`) before the endpoint's `upgrade()` runs. A guard that returns `false` answers the upgrade with 403. Guards can tell an upgrade apart by `ctx.upgrade`, which is `{ path }` (the endpoint path) on upgrades and `null` otherwise; `ctx.route` is `null` on upgrades. Browsers cannot set headers such as `Authorization` on a WebSocket, so a guard that authenticates by header should let upgrades through and leave authentication to the endpoint (for GraphQL, `subscriptions.onConnect`):

```ts
const BearerGuard = (ctx: Ctx) => ctx.upgrade !== null || isValidToken(ctx.req.headers.get('authorization'));
```

A guard passes only when it returns (or resolves to) exactly `true`; any other value, truthy or not, is a 403. `ctx.meta` is the matched route's metadata (`ctx.route?.meta`, from `createRouteDecorator()` and the `meta` option), or an empty frozen object on unmatched requests and upgrades. GraphQL resolver contexts expose the same `ctx.meta`, so one role guard works on routes and resolvers. Deny when required roles are present but unmet:

```ts
const Roles = createRouteDecorator<string[]>('roles');

const RolesGuard = (ctx: Ctx) => {
  const required = ctx.meta.roles as string[] | undefined;
  if (!required?.length) return true;
  const roles = currentUser(ctx)?.roles ?? []; // no user: no roles, so denied
  return required.some((role) => roles.includes(role));
};
```

Errors are RFC 9457 `application/problem+json`. Outside development (`HpmwsFactory.create(root, { development })`, default `NODE_ENV === 'development'`), a 5xx `HttpException` is sent with only `type`, `title`, `status` and `instance`: its `detail` and extensions are dropped (headers such as `Retry-After` are kept), and unknown errors are a bare 500. 4xx problems keep their detail and extensions.

Request bodies are capped at 1 MiB by default; larger bodies are answered with 413. Raise or lower the cap with `listen({ maxRequestBodySize })` (bytes).

`reloadTls()` hot-swaps certificates via `SO_REUSEPORT` and is Linux-only.

A `listen()` that failed to bind (for example, the port is taken) binds nothing and can be retried, but the application context stays open. If you give up instead, call `await app.close()` so shutdown hooks run and resources are released. A `listen()` that failed because a lifecycle hook threw (such as `onModuleInit` of a middleware, guard or filter, which runs at `listen()`) has already closed the application and cannot be retried. `listen()` always rejects once `close()` has started, including a `close()` issued while `listen()` is still initializing:

```ts
try {
  await app.listen({ port: 3000 });
} catch (error) {
  await app.close();
  throw error;
}
```

If `close()` runs while `listen()` is still initializing and that wait exceeds `shutdownTimeout`, the listen is abandoned and classes whose `onModuleInit` was still running do not receive `onModuleDestroy`.

`bun add @hpmws/core @hpmws/http` (`@hpmws/core` is a peer dependency). Licensed MIT OR Apache-2.0.
