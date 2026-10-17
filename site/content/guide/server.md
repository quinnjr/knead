---
title: Server
description: Create the application, listen with Bun.serve, terminate TLS, run behind a proxy, restrict hosts, set server limits and shut down gracefully.
---

An application goes through two steps: `KneadFactory.create()` builds the dependency injection
context, and `app.listen()` compiles the routes and binds the listener with `Bun.serve`. This page
covers both, and everything the server does before a request reaches
[the request pipeline](/guide/middleware/#the-request-pipeline).

<<< http-pipeline/server.ts#production title="main.ts"

## Creating the application

`KneadFactory.create(rootModule, options?)` resolves the module graph, constructs every singleton
provider, runs `onModuleInit` and `onApplicationBootstrap` hooks (see
[lifecycle](/guide/lifecycle/)) and returns an `HttpApplication`. Its `CreateApplicationOptions`
are:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `development` | `boolean` | `process.env.NODE_ENV === 'development'` | Development mode: 500 responses include error details, and `allowedHosts` defaults to loopback names. Injectable as `HTTP_DEVELOPMENT`. |
| `logger` | `Logger` | The `LOGGER` of a global module (such as `LoggingModule`), else a `ConsoleLogger` | The `LOGGER` of every module, replacing any module's own `LOGGER` provider. |
| `overrides` | `Iterable<readonly [Token, Provider]>` | none | Replaces non-multi providers by token, in every module. A `LOGGER` entry here wins over `logger`. Used by [testing](/guide/testing/). |

The factory also registers `HttpCoreModule`, a global module that provides `WsRegistry` and
`ErrorLog` to every module; `HTTP_DEVELOPMENT` comes from the application context. See [logging](/guide/logging/) for loggers.

## Listening

`app.listen(options?)` resolves to the Bun `Server` once it is bound. Before binding it validates
the options, compiles the routes (configuration mistakes such as duplicate routes or invalid guards
are an `HttpConfigError` here), constructs middleware, guards and filters, and runs their
`onModuleInit` hooks. Then it logs `Listening on <url>` at info level.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | `number` | `3000` | TCP port. `0` picks a free port. |
| `hostname` | `string` | `'0.0.0.0'` | Interface to bind. |
| `tls` | `TLSOptions \| TLSOptions[]` | none | Bun TLS options; an array serves several certificates by SNI. See [TLS](#tls). |
| `redirectHttp` | `{ port: number; hostname?: string; host?: string }` | none | A second, plain-HTTP listener that redirects to HTTPS. Requires `tls`. |
| `allowedHosts` | `readonly string[] \| false` | Development: loopback names. Production: no check. | Host names the server answers to. See [allowed hosts](#allowed-hosts). |
| `trustProxy` | `false \| number \| readonly string[]` | `false` | Which proxies' `X-Forwarded-*` headers to believe. See [proxies](#running-behind-a-proxy). |
| `maxRequestBodySize` | `number` | `1048576` (1 MiB) | Largest request body in bytes; a larger one gets `413`. An integer of at least 1. |
| `maxParams` | `number` | `1000` | Most query parameters (more is a `400`) or urlencoded or multipart body fields (more is a `413`) parsed per request. An integer of at least 1. |
| `idleTimeout` | `number` | Bun's default (10 seconds) | Seconds a connection may be idle before Bun closes it. An integer from 0 to 255. |
| `defaultCacheControl` | `string` | none | `Cache-Control` value added to responses that have none, for example `'no-store'`. |
| `validation` | `ValidationOptions` | `{}` | `{ redactIssueMessages: true }` makes validation issue messages generic. See [validation](/guide/validation/). |
| `websocket` | `WsServerOptions` | `WS_DEFAULTS` | Server-wide WebSocket limits. See [WebSockets](/guide/websockets/#limits). |
| `shutdownTimeout` | `number` | `10000` | Milliseconds `close()` waits for in-flight requests: an integer of at least 0. See [shutdown](#graceful-shutdown). |

`listen()` can be called once. A second call, or a call after `close()` has started, rejects with
an `HttpConfigError`. `useGlobalMiddleware()`, `useGlobalGuards()` and `useGlobalFilters()` must be
called before it.

### When `listen()` fails

A `listen()` that fails to bind (the port is taken, for example) leaves no partial state and can
be retried, but the application context stays open. If you give up instead, `await app.close()`
so shutdown hooks run and resources such as database connections are released, as `bootstrap()`
above does. A `listen()` that fails because a lifecycle hook threw (an `onModuleInit` of a
middleware, guard or filter class) has already closed the application, and cannot be retried.

### The `HttpApplication`

| Member | Description |
| --- | --- |
| `listen(options?)` | Binds the server, as above. |
| `close(signal?)` | Graceful shutdown. Idempotent: every call returns the same promise. |
| `enableShutdownHooks(signals?, options?)` | Calls `close()` on process signals. |
| `get(token)` | Resolves a provider from the root module, like `context.get()`. |
| `useGlobalMiddleware(middleware, priority = 0)` | Adds global middleware. See [middleware](/guide/middleware/#global-middleware). |
| `useGlobalGuards(...guards)` | Adds global guards. See [guards](/guide/guards/). |
| `useGlobalFilters(...filters)` | Adds global exception filters. See [exception filters](/guide/exception-filters/). |
| `server` | The Bun `Server`. Throws an `HttpConfigError` before `listen()`. |
| `url` | The server's `URL`. Throws before `listen()`. |
| `port` | The main listener's TCP port. Throws before `listen()`. |
| `redirectUrl` | The `URL` of the `redirectHttp` listener, or `undefined`. |
| `routes` | The compiled route table: `{ method, path, handler }` entries, where `handler` is `Controller.method`. Empty before `listen()`. |
| `reloadTls(tls)` | Replaces the certificates without dropping connections. See [TLS](#tls). |
| `context`, `logger`, `development` | The `ApplicationContext`, the resolved `LOGGER` and the development flag. |

## Graceful shutdown

`app.close(signal?)` shuts down in this order:

1. If `listen()` is still initializing, wait for it, for at most `shutdownTimeout`. Past that,
   the listen is abandoned and rejects without binding.
2. Stop accepting connections, and stop the `redirectHttp` listener.
3. Wait until in-flight requests finish, for at most `shutdownTimeout` milliseconds.
4. Close open WebSockets with code `1001` (`Server shutting down`), then close the remaining
   connections.
5. Run `beforeApplicationShutdown(signal)` and `onModuleDestroy()` hooks, in reverse
   initialization order.

`app.enableShutdownHooks(signals = ['SIGTERM', 'SIGINT'], { exit = true })` calls `close(signal)`
on the first of those signals and then exits the process with code `0`, or with code `1` after
logging `Graceful shutdown on <signal> failed`. Pass `{ exit: false }` to keep the process alive,
for example when something else owns the exit. It throws an `HttpConfigError` after `close()` has
started, and `close()` removes the signal listeners it added.

## TLS

Pass Bun's `TLSOptions` as `tls`. `ctx.secure` is then `true` for every request. Add `redirectHttp`
to serve a plain-HTTP listener that answers every request with a `308` redirect to the HTTPS
listener:

<<< http-pipeline/server.ts#tls title="main.ts"

The redirect keeps the request's path and query, and carries `cache-control: no-store` and
`x-content-type-options: nosniff`. Its `hostname` defaults to the main `hostname`.

- **With `host`** (recommended), every redirect goes to that canonical host. `host` may carry a
  port (`'api.example.com:8443'`), which replaces the HTTPS listener's port in the `Location`. It
  must be a plain `host[:port]` that the URL parser keeps exactly as written, or `listen()`
  rejects with an `HttpConfigError`: values like `1.2.3.256`, `[1.2.3.4]`, `xn--a`, `0x7f.1`,
  `[::0001]` and ports outside 1-65535 or with leading zeros are refused.
- **Without `host`**, the `Location` follows the request's `Host` header, with its port replaced by
  the HTTPS port. `listen()` logs a warning recommending `host`. A `Host` that is not a plain
  `host[:port]` gets `400 Invalid Host header`, and a host outside `allowedHosts` gets `421`.

`redirectToHttps(req, httpsPort, host?)` is the function the listener uses, exported for custom
listeners.

`app.reloadTls(tls)` swaps certificates at runtime: it binds a replacement listener on the same
port (`SO_REUSEPORT`) and lets the old one drain its in-flight requests. It works on Linux only, on
an application that listens with `tls`, and not while it is closing; otherwise it throws an
`HttpConfigError`.

Knead sets no TLS protocol or cipher options of its own, so the minimum protocol version and cipher
suites are Bun's defaults (BoringSSL). Restrict them through `TLSOptions`, or terminate TLS at a
proxy whose policy you control.

## Allowed hosts

`allowedHosts` protects against DNS rebinding, where a malicious page makes the browser send
requests with a foreign `Host` to your server. A request whose `Host` header names a host that is
not in the list gets `421 Misdirected Request` before middleware, routes and WebSocket upgrades
run:

```json
{
  "type": "about:blank",
  "title": "Misdirected Request",
  "status": 421,
  "detail": "This server does not serve the requested host."
}
```

Matching is on the host name only: case-insensitive, with ports and a trailing dot ignored. IPv6
entries may be written with or without brackets. A request without a `Host` header is rejected. The
first rejection of each distinct host (up to 100 hosts) is logged as a warning, so a legitimate
name missing from the list is easy to spot.

The default depends on development mode:

- **Development**: `['localhost', '127.0.0.1', '[::1]']`, plus the bound `hostname` unless it is
  `0.0.0.0` or `::`. A development server on loopback is exactly what a rebinding page targets.
- **Production**: no check, because Knead cannot know your public names. Set `allowedHosts` to
  them, for example `['api.example.com']`.

`allowedHosts: false` turns the check off in both modes.

## Running behind a proxy

By default `ctx.ip` and `ctx.secure` come from the socket, and `X-Forwarded-For` and
`X-Forwarded-Proto` are ignored (`X-Forwarded-Host` is never used). When one of these headers
arrives while `trustProxy` is off, Knead logs
one warning, since that usually means a proxy was left unconfigured. `trustProxy` says which
proxies to believe:

- **A list of CIDRs** (`['10.0.0.0/8', '2001:db8::/32']`): the addresses of your proxies.
  Starting at the socket peer, Knead walks `X-Forwarded-For` from right to left past trusted
  addresses, and the first untrusted address is `ctx.ip`. When the socket peer itself is not
  trusted, the headers are ignored. `X-Forwarded-Proto` is read from the entry the last trusted
  proxy appended. IPv4-mapped IPv6 entries (`::ffff:10.0.0.0/104`) match as the IPv4 range.
- **A hop count** (`1`, `2`, ...): the number of proxies in front of the app. The socket peer is
  trusted by definition, and a header with fewer entries than hops is ignored. `0` is the same as
  `false`.

Prefer CIDRs. A hop count trusts whatever the socket peer sends, so it is safe only when the port
is reachable from the proxy alone. `listen()` warns when a hop count is combined with a wildcard
`hostname` (`0.0.0.0` or `::`). `ctx.ip` is canonical either way: IPv4-mapped IPv6 becomes IPv4
and IPv6 is compressed (RFC 5952). See [request context](/guide/request-context/) for the other
`ctx` fields.

## Limits

The defaults bound what one request can cost:

| Limit | Default | Exceeded |
| --- | --- | --- |
| `maxRequestBodySize` | 1 MiB | `413` |
| `maxParams`: query parameters | 1000 | `400` |
| `maxParams`: urlencoded or multipart fields | 1000 | `413` |
| `idleTimeout` | Bun's default (10 seconds) | Connection closed |
| WebSocket limits (`websocket`) | See [WebSockets](/guide/websockets/#limits) | |

Parameters are counted before they are parsed, so an oversized query string or form is rejected
without building it. Parsed query strings and forms drop the keys `__proto__`, `constructor` and
`prototype`. JSON bodies drop `__proto__` keys at every depth, and `constructor` and `prototype`
keys whose value is an object. See
[prototype pollution](/guide/request-context/#prototype-pollution).

`defaultCacheControl` must be a non-empty header value without line breaks, and `maxParams` an
integer of at least 1; anything else is an `HttpConfigError` at `listen()`.

## Development mode warnings

Development mode exposes error details in responses, so `listen()` logs a warning when it is on and
the bound `hostname` is not loopback (the default `0.0.0.0` included). Bind to `127.0.0.1` during
development, or set `development: false`.

## Bun version

Knead requires Bun 1.4.3 or later (`MIN_BUN_VERSION`), which fixes CVE-2026-48618 (TLS hostname
matching, including `Bun.RedisClient`), request smuggling through bare-LF chunked bodies, WebSocket
frames sent with the upgrade request, `req.url` and headers of aborted requests, and the TLS
handshake idle timeout. `listen()` calls `checkBunVersion(logger)`, which logs a warning once per
process on an older Bun and returns whether the version is supported. `compareVersions(a, b)`
compares two `major.minor.patch` versions, ignoring pre-release and build suffixes, and returns a
negative number, `0` or a positive number.

## Adding headers to responses

`withHeaders(res, headers, overwrite = true)` adds headers to a `Response` and returns it. It
appends `set-cookie` values instead of replacing them, keeps headers the response already has when
`overwrite` is `false`, and copies the response when its headers are immutable (as on a `fetch()`
response), so always use the returned value. Middleware uses it to decorate the response from
`next()`; see [middleware](/guide/middleware/#writing-middleware).
