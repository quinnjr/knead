# @knead-js/http

## 0.5.0

### Minor Changes

- 151bf6c: **Breaking:** `@Injectable()` is now required on every class the container constructs as a
  provider, whether listed in `providers` or used through `useClass` (including testing overrides).
  An unmarked class is a `ProviderConfigError` at bootstrap naming the class and module. Value,
  factory and alias providers, and guard, middleware and filter classes, need no decorator.
  `@Controller()`, `@Resolver()` and `@Catch()` mark their classes. New `markInjectable(metadata)`
  lets other class decorators do the same; `normalizeProvider()` takes an optional `owner` for its
  error messages.

### Patch Changes

- Updated dependencies [151bf6c]
  - @knead-js/core@0.5.0

## 0.4.0

### Minor Changes

- 141cdf4: Harden the HTTP application and pipeline: both listeners run with Bun's development mode set to
  the application's flag and answer errors that reach Bun with a masked `500` problem (never Bun's
  HTML error page with the message and stack); the error handler always answers, dropping problem
  extensions that do not serialize (such as a `BigInt`); `listen()` rejects invalid
  `maxRequestBodySize`, `idleTimeout` and `shutdownTimeout` values and invalid middleware and
  filter references with an `HttpConfigError`; only `GET` requests are treated as WebSocket
  upgrades; `close()` awaits the redirect listener's stop and logs its failure; `ctx.headers` drops
  `__proto__`, `constructor` and `prototype` keys. `resolveGuard` is now exported.

### Patch Changes

- 141cdf4: WebSocket, proxy and testing fixes from the code review:
  
  - `trustProxy` CIDRs need a prefix of 1 to 3 decimal digits: `10.0.0.0/` (which `Number('')` read as `/0`, trusting every address), `/0x8`, `/ 8`, `/1e1` and `10.0.0.0/8/x` are now `HttpConfigError`s, as are non-string entries.
  - An upgrade whose guards took over 30 seconds returns its connection slot when its socket never opens, instead of holding it forever.
  - An endpoint `open()` that throws closes the socket with `1011` instead of leaving it open.
  - `message`, `close` and `drain` run only for sockets whose `open` ran (not for sockets revoked while upgrading or closed with `1013`).
  - `allowedOrigins` entries must be exact origins (`scheme://host[:port]`): paths, trailing slashes, default ports and wildcards are rejected at `register()`.
  - `maxConnectionLifetime` above `2 ** 31 - 1` and `idleTimeout` above 960 are rejected instead of closing every socket at once or wrapping around.
  - `HttpException` titles fall back to `node:http`'s reason phrases (`502 Bad Gateway`, `504 Gateway Timeout`, ...) before `'Error'`.
  - `TestApp.request()` and `graphqlSubscribe()` require paths starting with `/` and always target the test server (`'//host/x'` no longer goes to another host).
  - `graphqlSubscribe()` iterators reject on an abnormal close (any code but 1000) or a non-JSON frame instead of ending quietly or hanging.
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
  - @knead-js/core@0.4.0

## 0.3.0

### Minor Changes

- d35aafe: Add `sendRedisCommand()` to `@knead-js/core` (the connect-then-send-with-timeout step that `RedisStore` and `RedisLockStore` now share) and `isHeaderValue()` to `@knead-js/http`. GraphQL's `cacheControl` option is now validated with `isHeaderValue()`, so a value with a leading or trailing line feed is rejected at bootstrap like any other CR or LF. Internal simplifications: the route compiler adds the default `Cache-Control` once per handler, security headers send their prebuilt list as is when there is no nonce, and a cron job builds its timezone formatter only when it is first needed.

### Patch Changes

- 404aa0d: Fix conformance gaps found by a project-wide audit:
  
  - `redactValue` no longer returns a `Headers`, `Map` or other entries-like object unredacted at the depth limit or inside a cycle, and now redacts non-`Error` causes and `AggregateError.errors` deeper in a cause chain.
  - `JsonLogger` in development no longer hangs on an error that contains itself, and nested errors share the depth limit (at most 100 detailed errors per record).
  - Transients resolved after startup are no longer tracked for lifecycle hooks (an unbounded leak).
  - WebSocket endpoints are reachable behind a covering `/:param` or wildcard GET route; an explicit `undefined` no longer overrides WebSocket defaults; upgrade slots of sockets that never open are released.
  - CORS origin predicates, GraphQL `refreshContext` and revocation checks fail closed on non-`true`/non-object results.
  - More options are validated at startup instead of failing per request: route `status`, `defaultCacheControl`, security-header and CSP values Bun cannot send, CORS `origin`, rate-limit `store`/`key`/`middleware`, `sweepIntervalMs`, GraphQL `cacheControl`/CSRF headers/timeouts, sanitize preset names, `PrismaModule.forRootAsync` and `TransactionHost.run` `isolationLevel`.
  - The rate-limit Redis store's own client no longer queues commands while Redis is unreachable; the scheduler logs through the application `LOGGER`; cron jobs no longer re-fire during a DST fall-back hour; cron patterns are capped at 1024 characters.
  - Per-request work is cached (CORS and security headers, playground pages, interface resolution, route 405 lookup), and packages gain npm keywords, homepages and Bun-oriented descriptions.
- Updated dependencies [404aa0d]
- Updated dependencies [bebabd2]
- Updated dependencies [d35aafe]
  - @knead-js/core@0.3.0

## 0.2.1

### Patch Changes

- @knead-js/core@0.2.1

## 0.2.0

### Minor Changes

- 5296955: `KneadFactory.create` no longer registers its own `LOGGER`: a global module's `LOGGER` (such as `LoggingModule`'s) is now used in every module, not only in the modules that import it. The `logger` option replaces every module's `LOGGER`, including a global module's and a module's own `LOGGER` provider (it is applied as an override; an explicit `LOGGER` entry in `overrides` still wins).
- 7b77d69: Add `@knead-js/prisma`: `PrismaModule.forRoot()` / `forRootAsync()` and `PrismaService`, which connects the Prisma 7 client at bootstrap and disconnects it on shutdown; `TransactionHost` and `@Transactional()` for ambient transactions (`required` and `requiresNew` propagation); `@knead-js/prisma/http` with `PrismaHttpModule`, `PrismaExceptionFilter` and `toHttpException`, mapping Prisma errors to problem responses without exposing their messages; and `@knead-js/prisma/testing` with `withRollback`. Register your client type through `PrismaClientRegistry` to type `PrismaService.db`.
  
  `@knead-js/core` now owns `LOGGER`, `Logger`, `ConsoleLogger`, `MemoryLogger`, `logError` and the `DEVELOPMENT` token, and `ApplicationContext.create` provides a default `LOGGER` and `DEVELOPMENT` and accepts `logger` and `development` options. `@knead-js/http` re-exports the same objects.
  
  `@knead-js/http` exception filters can now decline by returning `undefined`, so later filters and the default mapping still run, and `defaultErrorResponse` is exported. `ExceptionFilter.catch` is typed `Response | undefined | Promise<Response | undefined>` (was `Response | Promise<Response>`). Behaviour change: a filter that returns `undefined` used to be logged as "did not return a Response" and stop the chain with the default mapping; it now passes the error on to the next filter without logging. Other non-`Response` values are still logged and stop the chain.
  
  `HTTP_DEVELOPMENT` is now an alias of core's `DEVELOPMENT` (the same token object), so its description is `'DEVELOPMENT'` rather than `'HTTP_DEVELOPMENT'`; `NoProviderError` messages and other token names in error text change accordingly.
  
  `TransactionHost.run` marks a joined (`required`) transaction rollback-only when an inner run rejects: if the owning run then resolves, the transaction rolls back and the owning run rejects with a `KneadError` whose `cause` is the inner rejection.
- 871883c: `@knead-js/http`: `WsRegistry.register()` accepts `meta`, route-style metadata that guards read as `ctx.meta` on the upgrade request (merged over the GET route's meta when the endpoint shares its path).
  
  `@knead-js/casl`: add `canMeta()` and `skipAbilityMeta()`, the meta forms of `@Can()` and `@SkipAbility()`, so a global `AbilityGuard` can authorize WebSocket endpoints that have no GET route.

### Patch Changes

- f779f8a: A route path whose `*` is not the whole last segment (`/a/*/b`, `/a*`) is a configuration error at `listen()`. Bun's router never matched such routes, so requests to them got a 405 from the fallback.
  
  Headers set on `ctx.res.headers` before a WebSocket upgrade (by middleware before `next()`, guards or the endpoint's `upgrade()`) are sent with the `101` handshake instead of being dropped. Headers that middleware adds to the returned response after `next()` still cannot reach the handshake, which Bun has already written.
- 82ce070: Add `@knead-js/schedule`: `@Cron`, `@Interval` and `@Timeout` jobs discovered on providers, an injectable `SchedulerRegistry` to add, pause, resume, trigger and remove jobs at runtime, graceful shutdown that waits for runs in progress, and optional `MemoryLockStore`/`RedisLockStore` locks so each cron firing runs on one instance. `parseIp`, `isLoopbackHostname`, `plaintextRedisHost`, `defaultRedisUrl` and the log redaction helpers (`redactCredentials`, `redactValue`, `summarizeError`, `logValue`) move to `@knead-js/core`; `@knead-js/http` still re-exports them.
- Updated dependencies [f779f8a]
- Updated dependencies [7b77d69]
- Updated dependencies [5296955]
- Updated dependencies [82ce070]
  - @knead-js/core@0.2.0

## 0.1.0

### Minor Changes

- 2fd4926: New opt-in `authorize` guards on HTTP routes and GraphQL resolvers, run after validation so they see the validated, transformed input (`ctx.body`/`ctx.query`/... or `ctx.args`). Ordinary guards still run before validation; the READMEs document the order.
- 2fd4926: Every package requires Bun `>=1.4.3` (`engines.bun`), which fixes CVE-2026-48618 (TLS hostname matching, including `Bun.RedisClient`), bare-LF chunked request smuggling and other server bugs. `listen()` logs a one-time warning on older Bun versions; `checkBunVersion()`, `compareVersions()` and `MIN_BUN_VERSION` are exported from `@knead-js/http`.
- 2fd4926: Framework error logging goes through one helper, `logError()` (exported, and injectable as `ErrorLog`): outside development it logs only the error's name and its message (redacted, then capped at 500 characters) under a correlation id, never the error object; in development the full error, redacted. The http pipeline, WebSocket registry, rate-limit store errors, GraphQL errors, subscriptions, Leaven's diagnostics and `RedisPubSub` use it, so redaction no longer depends on the configured logger. 5xx problem bodies carry the `correlationId`, and development 500 `detail`/`stack` are redacted. `RedisPubSub` logs topics JSON-quoted.
- 2fd4926: Guard references are validated at `listen()` (HTTP) and bootstrap (GraphQL): anything but an object with `canActivate()`, a function, or a class with `canActivate()` on its prototype (for example `undefined` from a circular import, or an arrow-function field) is an `HttpConfigError` naming the controller, route or resolver. `assertGuardRef()` is exported.
- 2fd4926: New `listen({ allowedHosts })` (DNS rebinding protection): a request whose Host is not listed gets `421 Misdirected Request` before middleware, routes, WebSocket upgrades and the Host-based HTTP→HTTPS redirect. The development default allows `localhost`, `127.0.0.1`, `[::1]` and the bound hostname; production has no check unless the option is set.
- 0f476dc: `listen()` caps request bodies at 1 MiB by default (`maxRequestBodySize`); larger bodies are answered with 413.
- 2fd4926: New opt-in `listen({ defaultCacheControl })`: applied to every response that has no `Cache-Control` of its own.
- 0f476dc: `HTTP_DEVELOPMENT` injects the application's resolved development flag. `listen()` warns when development mode is on and the bound hostname is not loopback.
- 0f476dc: `ConsoleLogger` masks URL credentials (`scheme://user:pass@` → `scheme://***@`) in messages, string arguments and Error messages, stacks and causes. `redactCredentials()` is exported.
- 2fd4926: Repeated query and form keys are collected in place (copying made 100k repeats quadratic), and the new `listen({ maxParams })` (default 1000) caps query parameters (400) and urlencoded/multipart body fields (413).
  
  **New default limit.** Requests with more than 1000 query parameters or form fields are now rejected; raise it with `app.listen({ maxParams: 5000 })`.
- 0f476dc: Every response the framework builds (JSON, text, `Blob`, bytes, streams, `204`, problems and HTTPS redirects) now carries `x-content-type-options: nosniff`.
- 0f476dc: Outside development, 5xx `HttpException` problem responses no longer include `detail` or extensions; only `type`, `title`, `status` and `instance` (plus the exception's headers) are sent.
- 2fd4926: New `listen({ validation: { redactIssueMessages: true } })` replaces body and query validation issue messages with `Invalid value` (paths kept), so schemas that quote input never echo it. The GraphQL README notes that graphql-js coercion errors quote values.
- 2fd4926: Log redaction covers more: credential URLs nested inside http(s) URLs, `password=`/`pwd=`/`secret=`/`token=`/`apikey=`-style pairs, `Bearer`/`Basic` credentials, and (through the new exported `redactValue()`) plain objects, arrays and Error own properties walked 4 levels deep, with sensitive keys such as `authorization` and `cookie` replaced by `***`. `ConsoleLogger` escapes control characters in messages and string meta, and the new `logValue()` caps and escapes client values interpolated into log messages. `MemoryLogger` is documented as tests-only (it keeps entries unredacted).
- 0f476dc: `redirectHttp.host` sets a canonical host for the HTTP→HTTPS redirect (the request's Host header is then ignored), and the 308 is sent with `cache-control: no-store`.
- 0f476dc: A route with more than one `*` wildcard is rejected at `listen()` with an `HttpConfigError`.
- 0f476dc: Guards pass only when they return exactly `true` (truthy values such as `1` or `'yes'` are now a 403). `ctx.meta` aliases `ctx.route?.meta`, or an empty frozen object without a route, so role guards read the same `ctx.meta` on routes and GraphQL resolvers.
- 0f476dc: `trustProxy` hardening: in hop mode, `X-Forwarded-For`/`X-Forwarded-Proto` with fewer entries than hops are ignored; `ctx.ip` is canonicalized from the parsed bytes (hex IPv4-mapped and expanded IPv6 included); one warning is logged when `X-Forwarded-*` arrives while `trustProxy` is off. `normalizeIp`, `parseIp` and `formatIp` are exported.
- 0f476dc: `Ctx.upgrade` is `{ path }` on WebSocket upgrade requests and `null` otherwise, so global middleware and guards can tell upgrades apart.
- 0f476dc: Global guards (`APP_GUARD` and `useGlobalGuards()`) now also run on WebSocket upgrade requests, with `ctx.route` set to `null`. A guard that returns `false` answers the upgrade with 403.
- 2fd4926: A WebSocket upgrade on the path of a `GET` route now also runs that route's module, controller and route middleware and its controller and route guards (after the global ones), with `ctx.route`/`ctx.meta` set to the route. Previously a controller guard such as an admin check did not protect a WebSocket endpoint sharing its path. Endpoints without a `GET` route are unchanged.
- 0f476dc: After a `body` schema validates, `ctx.json()` resolves to the validated value. Validation issues from the `headers` source use the generic message `Invalid header value` (the path is kept).
- 0f476dc: `maxConnectionsPerIp` groups IPv6 clients by /64 (new `listen({ websocket: { ipv6Subnet } })`, default 64). `maskIp(ip, prefix)` moved from `@knead-js/rate-limit` into `@knead-js/http` (rate-limit re-exports it).
- 0f476dc: WebSocket limits with safe defaults through `listen({ websocket })`: `maxPayloadLength` 256 KiB, `backpressureLimit` 1 MiB with `closeOnBackpressureLimit`, `idleTimeout` 120s, `maxConnectionsPerIp` 100 (429 above it), optional `maxConnections` (503), and a per-socket `messageRate` token bucket (100 messages per 10s; closes with 1008). Endpoints can override `messageRate` and set `maxConnectionLifetime` (closes with 4408). `WsRegistry.closeWhere(predicate, code?, reason?)` closes matching sockets.
- 0f476dc: WebSocket endpoints accept only same-origin upgrades by default (same scheme via `ctx.secure`, same host, default ports normalized, `Origin: null` rejected, no Origin allowed); a disallowed origin is a 403 before guards run. `WsRegistry.register(path, endpoint, { allowedOrigins })` lists more origins or `'*'`. `originAllowed()` is exported.
- aec5edd: Initial release of the Knead framework: DI and modules, HTTP(S) with schema-typed REST controllers, CORS, rate limiting, security headers, HTML sanitization and testing utilities.
- 690f12a: The framework formerly called hpmws is now Knead, and the packages are published as `@knead-js/*` (formerly `@hpmws/*`), from the renamed repository `quinnjr/knead`. There are no deprecated aliases:
  
  - `HpmwsFactory` is now `KneadFactory`, and `HpmwsError` is now `KneadError`.
  - Every `hpmws:` string namespace is now `knead:`: the metadata keys and symbol descriptions (`knead:module`, `knead:controller`, `knead:graphql:type`, …), the copy-guard symbols `Symbol.for('knead.core')` and `Symbol.for('knead.core.duplicateWarned')`, and the `ConsoleLogger` names (`knead:graphql`, `knead:rate-limit`; the default prefix is `[knead]`).
  - The default Redis prefixes change: `RedisPubSub` channels use `knead:gql:` and `RedisStore` keys use `knead:rl:`. Update Redis ACLs that restrict keys or channels to the old prefix (for example `~knead:rl:*`).
  - `RedisPubSub` derives its AES-256-GCM key with the HKDF label `knead:redis-pubsub:aes-256-gcm`, so instances on different versions cannot read each other's encrypted payloads.
  - The Standard Schema `vendor` of `@knead-js/sanitize` schemas is `knead`.
- 2fd4926: `@knead-js/http` exports `plaintextRedisHost()` (plus `isLoopbackHostname()` and `defaultRedisUrl()`), used by `RedisPubSub` and now also `RedisStore` to warn about plaintext `redis://`/`valkey://` URLs to non-loopback hosts (IPv4-mapped loopback included). Both accept `requireTls: true` to throw instead. `RedisStore` accepts a `logger`.
- 60dac85: Publish under the `@knead-js` npm scope (`@knead` was not available). Package imports change from `@knead/<name>` to `@knead-js/<name>`; the framework is still called Knead, and class names (`KneadFactory`, `KneadError`) and the `knead:` metadata, Redis and logger namespaces are unchanged.
- 2fd4926: Revocations kept for upgrading sockets no longer fail legitimate upgrades closed after unrelated `closeWhere()` bursts: the list holds `websocket.maxPendingRevocations` (new, default 10000) predicates, a predicate leaving it is first checked against every upgrade that already has its socket data, and only an upgrade that could not be checked (still in its guards, or no longer pending) fails closed. A slow upgrade alone no longer fails closed. Expired upgrades are swept in amortized batches, so 20k upgrades plus `closeWhere()` calls take milliseconds instead of seconds.

### Patch Changes

- 2fd4926: The per-socket cap on revocations deferred until a GraphQL socket's init completes is the registry's `websocket.maxPendingRevocations` (default 10000, exposed as `WsRegistry.maxPendingRevocations`) instead of a fixed 100; overflow still fails closed with 1008.
- 2fd4926: A Host rejected with 421 by `allowedHosts` is logged once per distinct host, with a hint to add it to `listen({ allowedHosts })`.
- 2fd4926: The `Bearer`/`Basic` `:`/`=` branch needs a token character right before and after the separator, so "basic setup: done" stays readable while `Basic user:pass` is still redacted. Short tokens such as `Bearer abc123` stay unredacted (documented known limit).
- 2fd4926: `Bearer`/`Basic` redaction applies only to credential-shaped values (8+ token characters, or containing `:`/`=`), so prose such as "Invalid basic auth header; a basic mistake" stays readable.
- 0f476dc: `WsRegistry.closeWhere` logs a predicate that throws for one socket and keeps checking the rest.
- 0f476dc: Requests whose `Host` header does not form a valid URL (Bun then gives them a relative `req.url`) no longer fail with a bare 500: routing, `ctx.query`, 404/405 and problem responses resolve the URL through the new exported `requestUrl(req)`, and the `redirectHttp` listener answers `400` unless a canonical `host` is configured.
- 2fd4926: The JSON key-filtering pass runs only for a literal `__proto__`/`constructor`/`prototype` or a `\u00XX` escape of a printable ASCII character, so `ensure_ascii` payloads with non-ASCII text stay on the native fast path. Legitimate `constructor`/`prototype` keys holding objects are still dropped (documented).
- 2fd4926: JSON bodies use the key-dropping reviver only when the text contains `__proto__`, `constructor`, `prototype` or a `\u` escape, so ordinary bodies parse at native speed again (the reviver made every body about 7x slower). Documented that `constructor`/`prototype` keys holding objects are dropped.
- 2fd4926: Multipart bodies are buffered (within `maxRequestBodySize`) and their boundary delimiters counted before the multipart parser runs: more than `maxParams` parts is a 413 without parsing any of them.
- 2fd4926: Parsed query strings and forms drop `__proto__`, `constructor` and `prototype` keys, and JSON bodies drop `__proto__` (and `constructor`/`prototype` holding objects) at every depth, so merging a body into an object cannot change its prototype.
  
  **Behaviour change:** legitimate `constructor` or `prototype` keys are dropped too (in JSON when they hold an object; in query strings and forms always), so an API that uses those field names must rename them.
- 2fd4926: `validation.redactIssueMessages` also makes `params` issue messages generic. Documented that route `authorize` guards do not run on WebSocket upgrades (only `guards` do).
- 2fd4926: `redactValue` also walks own enumerable Symbol keys.
- 2fd4926: `redactValue` survives throwing getters (`[unreadable]`) and hostile Proxies (a summary), and walks `Headers`, `Map` and header-like objects (`entries()`/`toJSON()`, e.g. AxiosHeaders) so `err.config.headers.Authorization` is redacted. `ConsoleLogger` and `logError` never throw into the caller, so a logging failure cannot turn into Bun's development error page.
- 2fd4926: Secret `key=value` redaction matches keys case-insensitively with any prefix or suffix (`access_token=`, `client_secret=`, `id_token=`, `DB_PASSWORD=`, `PGPASSWORD=`), still in linear time, and `Bearer`/`Basic` credentials in any case.
- 0f476dc: `redactCredentials` runs in linear time: a scheme may only start where no scheme character precedes it, and the scheme (32) and userinfo (1024) scans are capped. Pathological 1 MB inputs previously took seconds.
- 0f476dc: `redactCredentials` exempts `host[:port]/path@…` only for `http:` and `https:` URLs, so `redis://admin:2024/pw@host` is masked. Passwords with spaces or quotes cannot appear unencoded in a valid URL and are not recognized.
- 0f476dc: `redactCredentials` (and so `ConsoleLogger`) masks the whole URL userinfo, up to the last `@` before the host, so passwords containing `@` or `/` (`redis://u:p@ss@h`, `redis://u:a/b@h`) no longer leak.
- 2fd4926: `redirectHttp.host` must round-trip through the URL parser: values such as `1.2.3.256`, `[1.2.3.4]`, `xn--a`, `0x7f.1` or `:99999`, which the URL setters silently rejected (so the Location fell back to the request's Host), are now a configuration error at `listen()`. The canonical origin is computed once and the Location is built as origin + path + query.
- 2fd4926: Without `redirectHttp.host`, the HTTP→HTTPS redirect validates the request's Host with the same strict, round-tripping `host[:port]` check and answers 400 when it fails; `listen()` warns that `host` is unset.
- 2fd4926: `trustProxy` accepts IPv4-mapped CIDR entries (`::ffff:10.0.0.0/104` matches as `10.0.0.0/8`), and `listen()` warns once when a hop count is combined with a wildcard hostname (`0.0.0.0`/`::`).
- 2fd4926: A WebSocket upgrade on a GET route's path also runs that route's `authorize` guards, after its `guards`. Upgrades are not validated, so `authorize` sees the raw request there.
- 2fd4926: `websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` must be 1 to 128: 0 put every IPv6 client into one group and is now a configuration error.
- 0f476dc: `maskIp(ip, prefix)` throws a `RangeError` unless the prefix is an integer from 0 to 128, and returns IPv4-mapped input (`::ffff:1.2.3.4`) in its IPv4 form, so it shares a key with `1.2.3.4`. `websocket.ipv6Subnet` and the rate-limit `ipv6Subnet` accept the same range (0 to 128), checked by the new exported `isIpv6Prefix`.
- 2fd4926: `RedisPubSub` isolates throwing `onError` callbacks (logged; the other listeners are still told), and a failing queued SUBSCRIBE/UNSUBSCRIBE no longer stalls its topic's queue. A listener whose graceful stop rejects during `close()` is logged instead of leaving an unhandled rejection.
- 2fd4926: Docs: the TLS floor is Bun's (BoringSSL) default, and `TestRequestInit.tls.rejectUnauthorized: false` is for tests only.
- 2fd4926: An older kept `closeWhere` predicate expiring can no longer lower a newer upgrade's checked mark, which closed healthy upgrades with 1008.
- 2fd4926: `WsRegistry.closeWhere()` no longer misses sockets that are still upgrading: predicates issued while an upgrade is in progress (in guards, or between `server.upgrade()` and `open`) are kept for up to 30s (at most 100) and applied to those sockets when they open.
- 2fd4926: A `closeWhere` predicate evaluated at eviction time gets a stand-in socket with only `data`; if it reads any other property the upgrade counts as not evaluated and fails closed at open. Documented that predicates should read only `ws.data`.
- 2fd4926: Kept `closeWhere` predicates are dropped when no upgrade is pending (on a `closeWhere` with nothing pending, and when a socket closes), so an idle server holds no predicate closures.
- 2fd4926: `closeWhere` predicates kept for upgrading sockets are applied before the endpoint's `open` runs, and fail closed: when one newer than the socket's upgrade was already evicted or expired (or the upgrade took over 30s), the socket is closed with 1008 "Revocation state unavailable". Upgrades that never open no longer keep the in-progress count up (30s TTL). GraphQL sockets revoked before they opened are checked again once their init completes.
- Updated dependencies [2fd4926]
- Updated dependencies [0f476dc]
- Updated dependencies [aec5edd]
- Updated dependencies [690f12a]
- Updated dependencies [60dac85]
  - @knead-js/core@0.1.0
