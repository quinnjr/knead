# @hpmws/http

HTTP(S) for hpmws: `@Controller` and `@Get`/`@Post`/… compiled into Bun's native router; schema-typed `Ctx` (Standard Schema); middleware, guards and exception filters; RFC 9457 errors; TLS, HTTP→HTTPS redirect (`redirectHttp` requires `tls`), graceful shutdown and a WebSocket endpoint registry (endpoint paths must be exact). An upgrade request passes through global middleware and global guards (`APP_GUARD` and `useGlobalGuards()`) before the endpoint's `upgrade()` runs. When the endpoint's path is also the path of a `GET` route, the upgrade is secured like that route: it also runs the route's module, controller and route middleware and its controller and route guards, in the usual order, with `ctx.route` and `ctx.meta` set to that route; an endpoint without a `GET` route sees only the global ones and `ctx.route === null`. A guard that returns `false` answers the upgrade with 403. Guards can tell an upgrade apart by `ctx.upgrade`, which is `{ path }` (the endpoint path) on upgrades and `null` otherwise. Browsers cannot set headers such as `Authorization` on a WebSocket, so a guard that authenticates by header (global, or on a controller whose `GET` route shares a WebSocket path) should let upgrades through and leave authentication to the endpoint (for GraphQL, `subscriptions.onConnect`):

```ts
const BearerGuard = (ctx: Ctx) => ctx.upgrade !== null || isValidToken(ctx.req.headers.get('authorization'));
```

A route path may contain at most one `*` wildcard; more is a configuration error at `listen()`.

Guard references are checked at `listen()`: a guard is an object with a `canActivate()` function, a guard function, or a class with a `canActivate()` method on its prototype. Anything else, such as `undefined` from a circular import or a class whose `canActivate` is an arrow-function field, is an `HttpConfigError` naming the controller or route (`APP_GUARD`, `useGlobalGuards()`). A guard passes only when it returns (or resolves to) exactly `true`; any other value, truthy or not, is a 403. `ctx.meta` is the matched route's metadata (`ctx.route?.meta`, from `createRouteDecorator()` and the `meta` option), or an empty frozen object on unmatched requests and upgrades. GraphQL resolver contexts expose the same `ctx.meta`, so one role guard works on routes and resolvers. Deny when required roles are present but unmet:

```ts
const Roles = createRouteDecorator<string[]>('roles');

const RolesGuard = (ctx: Ctx) => {
  const required = ctx.meta.roles as string[] | undefined;
  if (!required?.length) return true;
  const roles = currentUser(ctx)?.roles ?? []; // no user: no roles, so denied
  return required.some((role) => roles.includes(role));
};
```

Order: guards run before the route's schemas validate the request, so they see the raw request (`ctx.params`, `ctx.query` and `ctx.json()` unvalidated). Authorization that depends on validated or canonicalized input (a trimmed, lowercased email; a coerced id) belongs in the route's `authorize` guards, which run after validation and see the schema output; anything but `true` is a 403:

```ts
@Post('/invites', { body: InviteSchema, authorize: [(ctx) => canInvite(ctx.state.user, ctx.body.email)] })
```

Route schemas (`params`, `query`, `headers`, `body`; any Standard Schema) replace the matching `ctx` field with the schema output, and once a `body` schema has passed, `ctx.json()` resolves to the validated value too, so unvalidated fields cannot slip in through it. Failures are a 400 listing every issue with its `source` and `path`; issues from the `headers` source always carry the generic message `Invalid header value`, so header values (tokens, cookies) are never echoed back. Many schema libraries quote the offending input in their messages; `listen({ validation: { redactIssueMessages: true } })` replaces body and query issue messages with `Invalid value` too, keeping `source` and `path`.

Responses the framework builds from a handler's return value (JSON, text, `Blob`, bytes, streams, `204`), problem responses and redirects carry `x-content-type-options: nosniff`; a `Response` returned by a handler is sent as is. A `Blob` keeps its own `type`, so when serving user-uploaded files, force a download instead of letting the browser render them in your origin:

```ts
@Get('/files/:id')
download(ctx: Ctx) {
  ctx.res.headers.set('content-disposition', 'attachment');
  return this.files.blob(ctx.params.id);
}
```

Errors are RFC 9457 `application/problem+json`. Outside development (`HpmwsFactory.create(root, { development })`, default `NODE_ENV === 'development'`), a 5xx `HttpException` is sent with only `type`, `title`, `status` and `instance`: its `detail` and extensions are dropped (headers such as `Retry-After` are kept), and unknown errors are a bare 500. 4xx problems keep their detail and extensions. Every 5xx is logged under a correlation id, which the problem body carries as its `correlationId` extension member (GraphQL sends the same id as `extensions.correlationId`). Framework error logging goes through the exported `logError(options, message, error)` (injectable as `ErrorLog`, with `LOGGER` and `HTTP_DEVELOPMENT`): in development it logs the full error, redacted with `redactValue()`, and the 500 body's `detail` and `stack` are redacted too; otherwise it logs only `Name: message` (`summarizeError()`: the message redacted, then capped at 500 characters), with no stack, cause or properties. Redaction happens before `LOGGER` is called, so an injected pino or winston logger receives redacted data.

`ctx.ip` and `ctx.secure` come from the socket unless `listen({ trustProxy })` says which proxies to believe: a hop count (the number of proxies in front of the app) or a list of proxy CIDRs. In hop mode an `X-Forwarded-For` or `X-Forwarded-Proto` header with fewer entries than hops did not pass through every proxy and is ignored (the IP falls back to the socket peer and `secure` to the listener's TLS state). `ctx.ip` is canonical: IPv4-mapped IPv6 (`::ffff:7f00:1`) becomes `127.0.0.1` and IPv6 is lowercased and compressed (RFC 5952), so one client always gets one key; `normalizeIp()`, `parseIp()` and `formatIp()` are exported. CIDR entries may also be IPv4-mapped IPv6 (`::ffff:10.0.0.0/104`), which match as the IPv4 range `/(prefix - 96)`. Prefer CIDR mode: a hop count trusts whatever the socket peer sends, so it is only safe when the port is firewalled to the proxy, and `listen()` warns when a hop count is combined with a wildcard hostname (`0.0.0.0` or `::`). When `trustProxy` is off and a request arrives with `X-Forwarded-*` headers, one warning is logged, since that usually means a proxy was left unconfigured.

Development mode (`HpmwsFactory.create(root, { development })`, default `NODE_ENV === 'development'`) exposes error details, so `listen()` logs a warning when it is on and the bound hostname is not loopback (the default `0.0.0.0` included). The resolved flag is injectable anywhere as `inject(HTTP_DEVELOPMENT)`.

`listen({ allowedHosts })` protects against DNS rebinding: a request whose `Host` names a host outside the list gets `421 Misdirected Request` (problem+json) before middleware, routes and WebSocket upgrades run, so the WebSocket same-origin check, the GraphQL playground's subscription URL and the `redirectHttp` listener (when it has no canonical `host`) only ever see allowed hosts. Matching is on the hostname only, case-insensitive, with ports and a trailing dot ignored; IPv6 entries may be written with or without brackets. In development the default is `['localhost', '127.0.0.1', '[::1]']` plus the bound hostname (unless it is `0.0.0.0` or `::`), because a development server on loopback is exactly what a rebinding page targets. In production there is no check by default, since the framework cannot know your public names: set `allowedHosts` to them (`['api.example.com']`). `allowedHosts: false` turns the check off.

Responses carry no `Cache-Control` unless the handler sets one, so browsers and shared caches may apply their heuristics to them. For an API that serves per-user data, set `listen({ defaultCacheControl: 'no-store' })`: it is added to every response (errors and 404s included) that has no `Cache-Control` of its own. GraphQL responses already send `no-store`.

Request bodies are capped at 1 MiB by default; larger bodies are answered with 413. Raise or lower the cap with `listen({ maxRequestBodySize })` (bytes). Parsing is capped too: `listen({ maxParams })` (default 1000) limits query parameters (more is a 400) and urlencoded or multipart body fields (more is a 413). Parsed query strings, forms and JSON bodies drop `__proto__` keys (forms also drop `constructor` and `prototype`; JSON drops those two when they hold an object), at every depth, so `Object.assign(entity, ctx.body)` cannot change an object's prototype. Legitimate `constructor` or `prototype` keys holding objects are dropped as well, so rename such fields in your API. The filtering pass runs only when the body text contains `__proto__`, `constructor`, `prototype` or a `\u` escape; other bodies get a plain `JSON.parse`.

The `redirectHttp` listener answers with a `308` (`cache-control: no-store`) to the same path on the HTTPS listener. By default the Location host comes from the request's `Host` header; set `redirectHttp: { port: 80, host: 'example.com' }` to always redirect to a canonical host (`host` may carry a port, `example.com:8443`, which overrides the HTTPS listener's port). `host` must be a plain `host[:port]` that the URL parser keeps exactly as written (lowercase is fine; `1.2.3.256`, `[1.2.3.4]`, `xn--a`, `0x7f.1`, `[::0001]` and ports outside 1-65535 or with leading zeros are not), or `listen()` rejects. The Location is that origin plus the request's path and query; the request's Host is never used. Without `host`, the Location follows the request's `Host` header (with its port replaced by the HTTPS listener's), so that header must pass the same strict `host[:port]` check or the request gets `400` instead of a redirect, and `listen()` logs a warning recommending `host`. Everywhere else such a request is served as usual: `requestUrl(req)` (exported) resolves its relative `req.url` against `http://host.invalid` rather than throwing.

WebSocket endpoints check the upgrade's `Origin` before global guards and the endpoint's `upgrade()` run: by default only the same origin is accepted (same scheme, from `ctx.secure`, and the same host and port as the `Host` header, with default ports 80/443 normalized). Upgrades without an `Origin` (non-browser clients) are allowed, `Origin: null` is rejected, and anything else is a 403. List other origins per endpoint, or pass `'*'` to turn the check off:

```ts
ws.register('/live', endpoint, { allowedOrigins: ['https://app.example'] });
```

`CorsModule` also rejects disallowed origins on upgrades, so a cross-origin client must be allowed by both. `originAllowed(origin, host, secure, allowed?)` is exported for transports that check origins themselves.

WebSockets are limited by default. `listen({ websocket })` sets the server-wide limits:

| Option | Default | |
| --- | --- | --- |
| `maxPayloadLength` | 256 KiB | a larger message drops the connection (the default sits above `@hpmws/graphql`'s 100 KiB `maxQueryLength` plus its message envelope) |
| `backpressureLimit` / `closeOnBackpressureLimit` | 1 MiB / `true` | a reader that falls that far behind is closed |
| `idleTimeout` | 120 (seconds) | |
| `maxConnectionsPerIp` | 100 | open sockets per `ctx.ip`; further upgrades get 429 (`false` disables) |
| `ipv6Subnet` | 64 | IPv6 clients count per /64 (one client usually controls a whole /64); an integer from 1 to 128, where 128 counts full addresses (0 is rejected: it would group every IPv6 client together). IPv4-mapped addresses count as their IPv4 address (`maskIp(ip, prefix)` is exported and throws a `RangeError` for other prefixes) |
| `maxConnections` | none | open sockets in total; further upgrades get 503 |
| `messageRate` | `{ limit: 100, windowMs: 10_000 }` | per-socket token bucket; exceeding it closes with 1008 (`false` disables) |

Per endpoint, `register(path, endpoint, { allowedOrigins, messageRate, maxConnectionLifetime })` overrides the message rate and can cap how long a socket lives (`maxConnectionLifetime` in ms; on expiry it is closed with 4408). Behind a proxy without `trustProxy`, `ctx.ip` is the proxy's address for every client, so `maxConnectionsPerIp` caps all clients together at 100 sockets: set `trustProxy` (hop count or the proxy's CIDRs) so it counts clients, or, if the proxy enforces its own per-client limit, raise `maxConnectionsPerIp` or set it to `false` and rely on `maxConnections`. To revoke sockets, for example when a user signs out, `WsRegistry.closeWhere(predicate, code = 1008, reason = 'Connection revoked')` closes every open socket the predicate matches (it receives the socket; `ws.data.data` is what `upgrade()` returned) and returns how many it closed. Sockets whose upgrade is still in progress (in middleware or guards, or between `server.upgrade()` and `open`) are not open yet, so `closeWhere` keeps the predicate (for up to 30 seconds, at most 100 of them) and applies it to each such socket when it opens. A predicate that throws for a socket is logged and that socket stays open; the others are still checked:

```ts
ws.closeWhere((socket) => (socket.data.data as { userId: string }).userId === userId);
```

`reloadTls()` hot-swaps certificates via `SO_REUSEPORT` and is Linux-only.

TLS is terminated by Bun (BoringSSL), and hpmws sets no protocol or cipher options of its own: the TLS floor (minimum protocol version and cipher suites) is Bun's own default, which comes from BoringSSL. Pass Bun `TLSOptions` in `listen({ tls })` to restrict it further, terminate TLS at a proxy with a policy you control, and keep Bun up to date (see the `engines` field).

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

The default `ConsoleLogger` masks credentials before printing, in the message, in string arguments and in objects, arrays and Errors:

- URL userinfo: `redis://user:pass@host` is logged as `redis://***@host`. The userinfo runs to the last `@` within the first 1024 characters of the URL, so passwords with unencoded `@` or `/` are covered; only `http(s)://host[:port]/path@…` is left alone, because an `@` there is in the path, but a credential URL nested inside one (`https://api.example/proxy?to=redis://admin:pw@cache`) is still masked. Passwords containing spaces or quotes cannot appear unencoded in a valid URL and are not recognized, so percent-encode them in connection strings.
- Values of `key=value` pairs (query strings, key=value connection strings, environment dumps) whose key contains `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `api_key` or `accountkey` in any case and with any prefix or suffix (`access_token=`, `client_secret=`, `id_token=`, `DB_PASSWORD=`, `PGPASSWORD=`), and `Bearer`/`Basic` credentials in any case.
- Plain objects, arrays and Error own properties (including `AggregateError.errors`), walked 4 levels deep (cycles are handled): string values are masked as above, and the values of sensitive keys (`authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `api_key`, `accesstoken`, `refreshtoken`, `accountkey`, `privatekey`, `connectionstring`, case-insensitive) become `***`. An Error that needed masking is printed as its masked stack text, its masked properties and `Caused by:` chain. The originals are never modified.

Control characters (CR, LF, ESC and the rest of C0, and DEL) in the message and in string arguments are escaped (`\n`, `\x1b`), so a logged value cannot forge log lines. `redactCredentials()`, `redactValue()` and `logValue()` (caps a client-controlled value at 1024 characters and escapes it, for interpolating into messages) are exported for custom loggers. `MemoryLogger` is for tests only: it keeps entries exactly as logged, unredacted.

hpmws requires Bun 1.4.3 or later (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), request smuggling through bare-LF chunked bodies, WebSocket frames sent with the upgrade request, `req.url` and headers of aborted requests, and the TLS handshake idle timeout. `listen()` logs a warning once when it runs on an older Bun (`checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported).

`bun add @hpmws/core @hpmws/http` (`@hpmws/core` is a peer dependency). Licensed MIT OR Apache-2.0.
