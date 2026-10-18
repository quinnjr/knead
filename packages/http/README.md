# @knead-js/http

[![npm](https://img.shields.io/npm/v/@knead-js/http?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/http)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

The HTTP layer of Knead: controllers compiled into Bun's native router, schema-typed request
contexts, middleware, guards and exception filters, RFC 9457 errors, TLS, graceful shutdown and
WebSocket endpoints, all on `Bun.serve` and secure by default.

**[Documentation](https://quinnjr.github.io/knead/packages/http/)** · [Guide](https://quinnjr.github.io/knead/guide/controllers/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/http
```

Requires Bun 1.4.3 or newer. `@knead-js/core` is a peer dependency, shared with every other Knead
package. Route schemas accept any [Standard Schema](https://standardschema.dev) library (Valibot,
Zod, ArkType); install the one you use.

## Quick start

```ts
import { Injectable, inject, Module } from '@knead-js/core';
import { Controller, type Ctx, Get, KneadFactory } from '@knead-js/http';

@Injectable()
class Greeter {
  greet(name: string) {
    return `hello ${name}`;
  }
}

@Controller('/greet')
class GreetController {
  readonly greeter = inject(Greeter);

  @Get('/:name')
  greet({ params }: Ctx<{ params: { name: string } }>) {
    return { message: this.greeter.greet(params.name) };
  }
}

@Module({ controllers: [GreetController], providers: [Greeter] })
class AppModule {}

const app = await KneadFactory.create(AppModule);
await app.listen({ port: 3000 });
```

`KneadFactory.create()` bootstraps the module tree, and `listen()` compiles every route into Bun's
router and binds the server. `GET /greet/ada` answers `{"message":"hello ada"}`.

## Features

- **Native routing.** `@Controller()` and `@Get()`/`@Post()`/... compile into `Bun.serve` routes,
  with `ctx` typed from the path and the route's schemas.
- **Validation.** `params`, `query`, `headers` and `body` schemas (any Standard Schema) replace the
  matching `ctx` field with their output; failures are one 400 listing every issue.
- **Pipeline.** Global, module, controller and route middleware; guards before and after
  validation; exception filters per route, controller or application.
- **Fail-closed guards.** A guard passes only on exactly `true`. Invalid guard references are an
  `HttpConfigError` at `listen()`, not a silent pass.
- **RFC 9457 errors** as `application/problem+json`, with 5xx details masked outside development
  and every 5xx logged, redacted, under a correlation id.
- **Bounded input.** 1 MiB bodies, 1000 query parameters or form fields. Parsed queries and
  forms drop `__proto__`, `constructor` and `prototype` keys; JSON drops `__proto__` at every
  depth and `constructor` and `prototype` keys holding objects.
- **Production server.** TLS, an HTTP to HTTPS redirect listener, certificate hot reload,
  `allowedHosts` against DNS rebinding, proxy trust by CIDR or hop count, graceful shutdown.
- **WebSockets.** Exact-path endpoints behind the same middleware and guards, a same-origin check,
  and per-IP, per-socket and payload limits on by default.

## Controllers and validation

```ts
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Delete, Get, Post } from '@knead-js/http';
import * as v from 'valibot';
import { TodosService } from './todos.service.js';

const TodoId = v.object({
  id: v.pipe(v.string(), v.digits(), v.transform(Number)),
});

const CreateTodo = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

@Controller('/todos')
export class TodosController {
  readonly #todos = inject(TodosService);

  @Get('/')
  list() {
    return this.#todos.list();
  }

  @Get('/:id', { params: TodoId })
  get({ params }: Ctx<{ params: v.InferOutput<typeof TodoId> }>) {
    return this.#todos.get(params.id);
  }

  @Post('/', { body: CreateTodo, status: 201 })
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateTodo> }>) {
    return this.#todos.create(body.title);
  }

  @Delete('/:id', { params: TodoId })
  remove({ params }: Ctx<{ params: v.InferOutput<typeof TodoId> }>) {
    this.#todos.remove(params.id);
  }
}
```

- A handler's return value becomes the response: objects as JSON, strings as text, `Blob`s,
  bytes and streams as bytes, `undefined` as `204`. A returned `Response` keeps its status, body
  and headers; `ctx.res.headers` it does not have are added (`Set-Cookie` is appended), and
  `defaultCacheControl` when it has no `Cache-Control`.
- Set a status with the route's `status` option (an integer from 200 to 599, checked at
  `listen()`) or `ctx.res.status`, headers with `ctx.res.headers`. With `204`, `205` or `304` the
  returned value is dropped and the response has no body.
- Responses built from a return value, problem responses and redirects carry
  `x-content-type-options: nosniff`. When serving user uploads, set
  `Content-Disposition: attachment` so they are not rendered in your origin.
- A path may end in one `*` wildcard segment (`/files/*`). A `*` anywhere else is an
  `HttpConfigError` at `listen()`.

Validation failures list each issue's `source`, `path` and `message`. Issues from `headers` always
read `Invalid header value`, so tokens and cookies are never echoed back, and
`listen({ validation: { redactIssueMessages: true } })` does the same for the other sources.

## The request pipeline

Each request runs, in order: the `allowedHosts` check, global middleware (highest `priority`
first), module, controller and route middleware, then global, controller and route guards, then
validation, the route's `authorize` guards, and the handler. Middleware sees the response on the
way back out.

```ts
export const Roles = createRouteDecorator<string[]>('roles');

export const rolesGuard: GuardFn = (ctx) => {
  const required = ctx.meta.roles as string[] | undefined;
  if (required === undefined || required.length === 0) return true;
  const roles = currentUser(ctx)?.roles ?? [];
  return required.some((role) => roles.includes(role));
};
```

`@Roles(['admin'])` on a route sets `ctx.meta.roles`; `currentUser(ctx)` reads the user that a
session guard, earlier in the list, stored in `ctx.state`. No user means no roles, so the request
is denied.

- Guards see the raw request. Authorization that depends on validated input (a trimmed email, a
  coerced id) belongs in the route's `authorize` guards, which see the schema output.
- `ctx.meta` is the matched route's metadata, written by `createRouteDecorator()` and the `meta`
  option, so one role guard works on every route (and on GraphQL resolvers).
- Register application-wide pieces with the `APP_MIDDLEWARE`, `APP_GUARD` and `APP_FILTER` multi
  providers, or `useGlobalMiddleware()`, `useGlobalGuards()` and `useGlobalFilters()`. These
  throw an `HttpConfigError` once `listen()` has started (including while it is still
  initializing) or after `close()`.
- An exception filter returns a `Response`, or `undefined` to pass the error on to the next filter
  and finally to the default problem response.

## Errors

Throw an `HttpException` or one of its subclasses (`BadRequestException`, `NotFoundException`,
`ConflictException`, ...). The response is RFC 9457 problem JSON:

```json
{
  "sku": "sold-out",
  "type": "https://example.com/problems/sold-out",
  "title": "Conflict",
  "status": 409,
  "detail": "SKU sold-out is sold out",
  "instance": "/checkout/sold-out"
}
```

| Error | Outside development | In development |
| --- | --- | --- |
| 4xx `HttpException` | Sent in full, `detail` and extensions included | The same |
| 5xx `HttpException` | `type`, `title`, `status`, `instance` and `correlationId` only; headers such as `Retry-After` kept | `detail` and extensions kept |
| Any other error | A bare 500 with a `correlationId` | `detail` and `stack` added, credentials redacted |

Every 5xx is logged through `LOGGER` under the same correlation id: outside development only
`Name: message`, redacted, with no stack, cause or properties. Development mode is
`KneadFactory.create(root, { development })`, by default `NODE_ENV === 'development'`, and
`listen()` warns when it is on and the server binds a non-loopback hostname.

## Server

```ts
export const productionListen: ListenOptions = {
  port: 8080,
  allowedHosts: ['api.example.com'],
  trustProxy: ['10.0.0.0/8'],
  defaultCacheControl: 'no-store',
  maxRequestBodySize: 256 * 1024,
  shutdownTimeout: 15_000,
};

export async function bootstrap(
  listen: ListenOptions = productionListen,
): Promise<HttpApplication> {
  const app = await KneadFactory.create(AppModule);
  try {
    await app.listen(listen);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app.enableShutdownHooks();
}
```

| `listen()` option | Default | Description |
| --- | --- | --- |
| `port` / `hostname` | `3000` / `'0.0.0.0'` | The listener. |
| `tls` | none | Bun `TLSOptions`; serves HTTPS. |
| `redirectHttp` | none | A plain-HTTP listener answering `308` to HTTPS. Requires `tls`; set `host` to a canonical `host[:port]`. |
| `allowedHosts` | development: loopback names; production: no check | Other `Host` headers get `421`. Set it to your public names in production. |
| `trustProxy` | `false` | A list of proxy CIDRs (preferred) or a hop count, for `ctx.ip` and `ctx.secure`. |
| `maxRequestBodySize` | 1 MiB | Larger bodies get `413`. An integer >= 1; a string such as an unparsed env var is an `HttpConfigError`. |
| `maxParams` | `1000` | More query parameters get `400`, more form fields `413`. |
| `defaultCacheControl` | none | Added to every response without `Cache-Control` (including 404s, `421`s and rejected upgrades), such as `'no-store'`. A value that is not a valid header value is an `HttpConfigError` at `listen()`. |
| `shutdownTimeout` | `10000` | Milliseconds `close()` waits for in-flight requests (an integer >= 0). |

- `enableShutdownHooks()` closes the application on `SIGTERM` or `SIGINT` and exits: `close()`
  stops accepting connections, drains in-flight requests, closes WebSockets with `1001` and runs
  shutdown hooks.
- A `listen()` that failed to bind can be retried, but the context stays open: call
  `await app.close()` if you give up.
- `reloadTls()` swaps certificates without downtime (`SO_REUSEPORT`, Linux only). Knead sets no
  TLS protocol or cipher options of its own; the floor is Bun's (BoringSSL) default.
- Without `trustProxy`, forwarding headers are ignored and one warning is logged when they arrive.
  A hop count trusts whatever the socket peer sends, so use it only when the port is reachable
  from the proxy alone.
- `listen()` warns once when Bun is older than 1.4.3, which fixes CVE-2026-48618 and request
  smuggling through bare-LF chunked bodies.

## WebSockets

Inject `WsRegistry` and `register(path, endpoint, options?)` an endpoint at an exact path. Its
`upgrade(ctx)` returns the socket data, or `false` for a 403. An upgrade passes the host check,
global middleware, a same-origin `Origin` check and global guards first; when its path is also a
`GET` route's, that route's middleware and guards run too. A parametric or wildcard `GET` route
that covers the path (`/ws/:id`, `/*`) does not take its upgrades. Guards can tell upgrades apart
by `ctx.upgrade`.

| `listen({ websocket })` limit | Default |
| --- | --- |
| `maxPayloadLength` | 256 KiB; a larger message drops the connection |
| `maxConnectionsPerIp` | 100 (IPv6 grouped per `/64`); more upgrades get `429` |
| `maxConnections` | no limit; more upgrades get `503` |
| `messageRate` | 100 messages per 10 seconds per socket; exceeding it closes with `1008` |
| `backpressureLimit` | 1 MiB, then the slow reader is closed |
| `idleTimeout` | 120 seconds |

Per endpoint, set `allowedOrigins`, `messageRate` and `maxConnectionLifetime`. To revoke sockets
(on sign-out), `closeWhere(predicate)` closes every socket for which the predicate returns a
truthy value, including ones still upgrading when they open. The connection slot of an upgrade
whose socket has not opened after 30 seconds is given back; if it opens later it takes a slot
again, or is closed with `1013` when none is free. A limit option passed as `undefined` keeps its
default. Browsers cannot send an `Authorization` header on a WebSocket, so
authenticate in `upgrade()` (for example with a one-time ticket) rather than in a header guard.

## Logging

The `LOGGER` token, `ConsoleLogger`, `MemoryLogger` and the redaction helpers are re-exported from
`@knead-js/core` as the same objects. Inject `ErrorLog` to log an error yourself under a
correlation id with the application's development setting.

## Documentation

- [`@knead-js/http` reference](https://quinnjr.github.io/knead/packages/http/): every export and
  option.
- Guides: [controllers](https://quinnjr.github.io/knead/guide/controllers/),
  [request context](https://quinnjr.github.io/knead/guide/request-context/),
  [validation](https://quinnjr.github.io/knead/guide/validation/),
  [errors](https://quinnjr.github.io/knead/guide/errors/),
  [middleware](https://quinnjr.github.io/knead/guide/middleware/),
  [guards](https://quinnjr.github.io/knead/guide/guards/),
  [exception filters](https://quinnjr.github.io/knead/guide/exception-filters/),
  [the server](https://quinnjr.github.io/knead/guide/server/) and
  [WebSockets](https://quinnjr.github.io/knead/guide/websockets/).

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
