---
title: WebSockets
description: Register WebSocket endpoints with the WsRegistry, authenticate and guard upgrades, and rely on the default origin, payload, rate and connection limits.
---

Bun allows one WebSocket handler per server, so Knead puts a registry in front of it: modules
register endpoints by path with the `WsRegistry`, and the registry dispatches each socket's events
to its endpoint. `@knead-js/graphql` registers its subscription endpoint the same way. Upgrades go
through middleware and guards like HTTP requests, and every socket is bounded by default limits.

## Registering an endpoint

`WsRegistry` is provided to every module by the HTTP core module. Inject it into a provider and
register endpoints in `onModuleInit`, which runs before `listen()`:

<<< http-pipeline/websockets.ts#endpoint title="chat.gateway.ts"

`register(path, endpoint, options?)` takes:

- **`path`**: an exact path. It is normalized (`'chat/'` becomes `/chat`), and parameters
  (`/rooms/:id`) and wildcards are an `HttpConfigError`. Put variable parts in the query string,
  as `ticket` is here.
- **`endpoint`**: a `WsEndpoint<D>`, described below.
- **`options`**: a `WsEndpointOptions`, described in [per-endpoint options](#per-endpoint-options).

A duplicate path is an `HttpConfigError`, and so is a `register()` after `listen()`
(`WebSocket endpoint /late was registered after listen().`).

### The endpoint

A `WsEndpoint<D>` has one required method and four optional ones:

| Method | Called |
| --- | --- |
| `upgrade(ctx)` | On the upgrade request, after middleware and guards. Return the socket data (`D`) to accept, `false` to reject with `403`, or throw an `HttpException` for another status. May be `async`. |
| `open(ws)` | When the socket is open, unless it was closed first (a revocation, or `1013`). |
| `message(ws, message)` | For each message: a `string` for text frames, a `Buffer` for binary ones. |
| `close(ws, code, reason)` | When the socket has closed, if `open` ran for it. |
| `drain(ws)` | When a socket that hit backpressure can take more data. |

Each socket is a `WsSocket`, Bun's `ServerWebSocket` with `WsData` as its data: `ws.data.endpoint`
is the endpoint path, `ws.data.data` is what `upgrade()` returned, and `ws.data.ip` is the client
IP of the upgrade request (`ctx.ip`). Everything else, such as `send()`, `subscribe()` and
`publish()`, is Bun's API. `message`, `close` and `drain` run only for sockets whose `open` ran, so a
socket closed before it reached the endpoint (revoked while upgrading, or `1013`) never gets
them. An error thrown (or a rejected promise) in any handler is logged as
`WebSocket <event> handler for <path> threw`. One in `open` also closes the socket with `1011`
(`Internal error`), so a socket the endpoint failed to set up is never served; its `close` still
runs. One in `message`, `close` or `drain` does not close the socket.

### Authenticating the socket

Browsers cannot set headers such as `Authorization` on a WebSocket, so authenticate in
`upgrade()`, from what a browser can send: a cookie, or, as in the example, a short-lived
one-time ticket that an authenticated HTTP endpoint issued:

<<< http-pipeline/websockets.ts#tickets title="chat-tickets.ts"

Keep tickets single-use and short-lived: query strings tend to end up in proxy and access logs.

## How an upgrade is processed

A `GET` request with `Upgrade: websocket` to the path of a registered endpoint takes this path
(with any other method, the header is ignored and the request is an ordinary one):

1. The [host check](/guide/server/#allowed-hosts): a host outside `allowedHosts` gets `421`.
2. Global middleware, highest priority first. When the path is also the path of a `GET` route,
   that route's module, controller and route middleware follow, as in
   [the request pipeline](/guide/middleware/#the-request-pipeline).
3. The [origin check](#origins): a disallowed `Origin` gets `403`.
4. Global guards; on the path of a `GET` route, also that route's controller guards, route guards
   and `authorize` guards. Upgrades are not validated, so `authorize` guards see the raw request.
5. The endpoint's `upgrade(ctx)`. `false` gets `403` (`WebSocket upgrade rejected`).
6. The [connection limits](#limits): `503` over `maxConnections`, `429` over `maxConnectionsPerIp`.
7. Bun's `server.upgrade()`. A request that is not a valid WebSocket handshake gets `400`
   (`WebSocket upgrade failed`).

An error at any step goes to the exception filters (that `GET` route's filters, or the global ones
when there is no such route) and becomes the response. On success the client gets
`101 Switching Protocols`. Headers set on `ctx.res.headers` before the handshake (by middleware
before it calls `next()`, by guards or by `upgrade(ctx)`) are sent with the `101`, so an upgrade
can set a cookie. Middleware then sees a placeholder `101` response from `next()`, and headers it
adds to that response are not sent: Bun has already written the handshake.

An upgrade request to a path without a registered endpoint is handled as a plain HTTP request.

## Guards

Upgrades are guarded like routes: a global guard (`APP_GUARD`, `useGlobalGuards()`) runs on every
upgrade, and a guard that returns anything but `true` is a `403`. In guards, `ctx.upgrade` is
`{ path }` on upgrade requests and `null` otherwise, and `ctx.route` is the `GET` route that shares
the endpoint's path, or `null`.

A global guard that authenticates by header would deny every browser upgrade, so let upgrades
through and authenticate in `upgrade()`:

<<< http-pipeline/guards.ts#upgrades title="bearer.guard.ts"

Global guards that read route metadata, such as a roles guard or `@knead-js/casl`'s `AbilityGuard`,
see `ctx.meta`. On an endpoint without a `GET` route, provide it with the `meta` endpoint option.
See [guards](/guide/guards/) and [authorization](/guide/authorization/).

## Origins

Browsers do not apply CORS to WebSockets, so without a check any website could open a socket to
your server with the user's cookies (cross-site WebSocket hijacking). Each endpoint therefore
checks the upgrade's `Origin` header, after middleware and before guards:

- No `Origin` header: allowed. Browsers always send one, so the client is not a browser.
- The same origin as the request: allowed. The scheme comes from `ctx.secure`, the host and port
  from the `Host` header, and default ports (80, 443) are normalized.
- An origin listed in the endpoint's `allowedOrigins`: allowed.
- `Origin: null`, or anything else: `403` with the detail
  `Cross-origin WebSocket connections are not allowed.`

`allowedOrigins: '*'` turns the check off for the endpoint. When `CorsModule` is installed, it also
rejects upgrades from origins it does not allow (`Origin not allowed for WebSocket upgrade`), so a
cross-origin client must be allowed by both. `originAllowed(origin, host, secure, allowed?)` is the
check itself, exported for transports that verify origins on their own.

## Per-endpoint options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedOrigins` | `readonly string[] \| '*'` | Same origin only | Origins accepted in addition to the same origin. Each entry must be exactly an origin, `scheme://host[:port]` (any case), or `register()` throws: no path, trailing slash, query, credentials, default port or wildcard (`https://*.example.com` is not supported; list each origin). `'*'` disables the check. |
| `messageRate` | `WsMessageRate \| false` | The server's `messageRate` | Per-socket message rate for this endpoint. `false` disables it. |
| `maxConnectionLifetime` | `number` | No limit | Milliseconds after opening at which the socket is closed with `4408` (`Connection lifetime exceeded`). An integer from 1 to 2147483647 (`2 ** 31 - 1`, the largest `setTimeout()` delay). |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | none | Route-style metadata that guards read as `ctx.meta` on upgrades. On the path of a `GET` route it is merged over that route's meta, for upgrades only. Copied and frozen at `register()`. |

A `WsMessageRate` is `{ limit, windowMs }`: a token bucket of `limit` messages, refilled evenly
over `windowMs` milliseconds. Both are integers of at least 1.

## Limits

`listen({ websocket })` sets the server-wide limits, a `WsServerOptions`. The defaults are exported
as `WS_DEFAULTS`:

<<< http-pipeline/websockets.ts#limits title="main.ts"

| Option | Type | Default | Exceeded |
| --- | --- | --- | --- |
| `maxPayloadLength` | `number` | `262144` (256 KiB) | The connection is dropped (close code `1006`). The default is above `@knead-js/graphql`'s 100 KiB query limit plus its message envelope. |
| `backpressureLimit` | `number` | `1048576` (1 MiB) | Bytes buffered for a slow reader before backpressure applies. |
| `closeOnBackpressureLimit` | `boolean` | `true` | A socket over `backpressureLimit` is closed. |
| `idleTimeout` | `number` | `120` | Seconds without traffic before the socket is closed. An integer from 0 to 960. |
| `maxConnectionsPerIp` | `number \| false` | `100` | Further upgrades from that client get `429` (`Too many WebSocket connections from this address.`). `false` disables it. |
| `ipv6Subnet` | `number` | `64` | IPv6 clients are counted per prefix of this length (one client usually controls a whole /64). An integer from 1 to 128; 128 counts full addresses. |
| `maxConnections` | `number` | No limit | Open sockets in total; further upgrades get `503`. |
| `messageRate` | `WsMessageRate \| false` | `{ limit: 100, windowMs: 10000 }` | The socket is closed with `1008` (`Message rate exceeded`) and receives no more messages. `false` disables it. |
| `maxPendingRevocations` | `number` | `10000` | `closeWhere()` predicates kept for sockets that are still upgrading. See [revoking sockets](#revoking-sockets). |

Invalid values are an `HttpConfigError` at `listen()`, for example
`WebSocket maxPayloadLength must be an integer >= 1, got 0.`

> [!WARNING]
> Behind a reverse proxy without [`trustProxy`](/guide/server/#running-behind-a-proxy), every
> client has the proxy's IP, so `maxConnectionsPerIp` caps all clients together at 100 sockets.
> Configure `trustProxy` so it counts real clients, or, if the proxy enforces its own per-client
> limit, raise `maxConnectionsPerIp` or set it to `false` and rely on `maxConnections`.

The per-IP count uses `ctx.ip`, in which an IPv4-mapped IPv6 address is its IPv4 address. A
connection slot is taken just before the socket is upgraded and given back when it closes, or
right away when the upgrade fails. An upgrade whose socket has not opened after 30 seconds gives
its slot back too, so aborted upgrades cannot exhaust the limits; a socket that opens later takes
a slot again, or is closed with `1013` when none is free.

## Revoking sockets

`registry.closeWhere(predicate, code = 1008, reason = 'Connection revoked')` closes every open
socket for which `predicate(ws)` returns a truthy value, and returns how many it closed. The example's
`signOut()` uses it to disconnect a user who signed out. `closeAll(code = 1001, reason = 'Server
shutting down')` closes every socket; `close()` calls it during
[shutdown](/guide/server/#graceful-shutdown).

A socket whose upgrade is still in progress (in middleware or guards, or between the handshake and
`open`) is not open yet, so `closeWhere()` also keeps the predicate, for up to 30 seconds and at
most `maxPendingRevocations` predicates, and applies it to such a socket when it opens, before
the endpoint's `open` runs. The same rule holds there: any truthy result closes the socket. Revocation is fail-closed:

- Write predicates against `ws.data` alone. A predicate leaving the kept list early is checked
  against upgrades that already have their socket data, using a stand-in socket that has only
  `data`. A predicate that reads anything else counts as not evaluated, and that socket is closed
  with `1008` (`Revocation state unavailable`) when it opens.
- A socket that was still in its middleware or guards when a predicate newer than its upgrade was
  dropped cannot be checked, and is closed the same way when it opens.
- A predicate that throws for a socket is logged and leaves that socket open; the other sockets
  are still checked.

## Other registry members

| Member | Description |
| --- | --- |
| `get(path)` | The endpoint registered at `path`, or `undefined`. |
| `entries()` | An iterator of `[path, endpoint]` pairs. |
| `openSockets` | The number of open sockets. |
| `maxPendingRevocations` | The `websocket.maxPendingRevocations` limit in effect. |
| `handler()` | The Bun `WebSocketHandler` that `listen()` passes to `Bun.serve`. |
