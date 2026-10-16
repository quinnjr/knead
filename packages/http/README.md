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

Route schemas (`params`, `query`, `headers`, `body`; any Standard Schema) replace the matching `ctx` field with the schema output, and once a `body` schema has passed, `ctx.json()` resolves to the validated value too, so unvalidated fields cannot slip in through it. Failures are a 400 listing every issue with its `source` and `path`; issues from the `headers` source always carry the generic message `Invalid header value`, so header values (tokens, cookies) are never echoed back.

Responses the framework builds from a handler's return value (JSON, text, `Blob`, bytes, streams, `204`), problem responses and redirects carry `x-content-type-options: nosniff`; a `Response` returned by a handler is sent as is. A `Blob` keeps its own `type`, so when serving user-uploaded files, force a download instead of letting the browser render them in your origin:

```ts
@Get('/files/:id')
download(ctx: Ctx) {
  ctx.res.headers.set('content-disposition', 'attachment');
  return this.files.blob(ctx.params.id);
}
```

Errors are RFC 9457 `application/problem+json`. Outside development (`HpmwsFactory.create(root, { development })`, default `NODE_ENV === 'development'`), a 5xx `HttpException` is sent with only `type`, `title`, `status` and `instance`: its `detail` and extensions are dropped (headers such as `Retry-After` are kept), and unknown errors are a bare 500. 4xx problems keep their detail and extensions.

`ctx.ip` and `ctx.secure` come from the socket unless `listen({ trustProxy })` says which proxies to believe: a hop count (the number of proxies in front of the app) or a list of proxy CIDRs. In hop mode an `X-Forwarded-For` or `X-Forwarded-Proto` header with fewer entries than hops did not pass through every proxy and is ignored (the IP falls back to the socket peer and `secure` to the listener's TLS state). `ctx.ip` is canonical: IPv4-mapped IPv6 (`::ffff:7f00:1`) becomes `127.0.0.1` and IPv6 is lowercased and compressed (RFC 5952), so one client always gets one key; `normalizeIp()`, `parseIp()` and `formatIp()` are exported. When `trustProxy` is off and a request arrives with `X-Forwarded-*` headers, one warning is logged, since that usually means a proxy was left unconfigured.

Request bodies are capped at 1 MiB by default; larger bodies are answered with 413. Raise or lower the cap with `listen({ maxRequestBodySize })` (bytes).

The `redirectHttp` listener answers with a `308` (`cache-control: no-store`) to the same path on the HTTPS listener. By default the Location host comes from the request's `Host` header; set `redirectHttp: { port: 80, host: 'example.com' }` to always redirect to a canonical host (`host` may carry a port, `example.com:8443`, which overrides the HTTPS listener's port). `host` must be a plain `host[:port]`, or `listen()` rejects.

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
