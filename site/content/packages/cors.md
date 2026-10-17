---
title: CORS
description: Global CORS middleware that answers preflights before routing and rejects unsafe configurations at startup.
---

```bash
bun add @knead-js/core @knead-js/http @knead-js/cors
```

`@knead-js/core` and `@knead-js/http` are peer dependencies, so every package shares one copy.

`@knead-js/cors` adds Cross-Origin Resource Sharing headers to every response, answers preflight
requests itself, and rejects WebSocket upgrades from origins it does not allow. Configuration
mistakes that would open the API to every site (`'*'` with credentials, an unanchored RegExp) are
errors when the module is created, not surprises in production. For how it fits with the other
security modules, see [security](/guide/security/). For middleware ordering in general, see
[middleware](/guide/middleware/).

## `CorsModule`

`CorsModule.forRoot(options: CorsOptions): DynamicModule` validates the options with
`validateCorsOptions()` and returns a global module that provides `CORS_OPTIONS`, `CorsMiddleware`
and an `APP_MIDDLEWARE` entry with priority 1000. Import it once, in the root module.

<<< security/cors.ts#module title="app.module.ts"

<<< security/cors.ts#list title="cors.ts"

Because it is global middleware, CORS runs for every request: matched routes, unmatched paths
(404 and 405 answers), WebSocket upgrades, and errors. A guard that rejects a request, or a handler
that throws, still produces a response with the CORS headers, so the browser can read the error.

## `CorsOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `origin` | `CorsOrigin` | required | Which origins are allowed. See [origin rules](#origin-rules). |
| `methods` | `readonly string[]` | `GET, HEAD, PUT, PATCH, POST, DELETE` | Sent as `Access-Control-Allow-Methods` on preflights, joined with `, `. |
| `allowedHeaders` | `readonly string[]` | reflect the request | Sent as `Access-Control-Allow-Headers` on preflights. Unset, the preflight's `Access-Control-Request-Headers` value is echoed back. |
| `exposedHeaders` | `readonly string[]` | none | Sent as `Access-Control-Expose-Headers` on allowed non-preflight responses, when the list is not empty. |
| `credentials` | `boolean` | `false` | Sends `Access-Control-Allow-Credentials: true` to allowed origins. Cannot be combined with `origin: '*'`. |
| `maxAge` | `number` | none | Seconds a browser may cache a preflight, sent as `Access-Control-Max-Age`. A non-negative integer. |

### Origin rules

`CorsOrigin` is the type of `origin`:
`string | readonly string[] | RegExp | ((origin: string, ctx: Ctx) => boolean | Promise<boolean>)`.

| Value | Allowed when |
| --- | --- |
| `'*'` | Any origin. The response says `Access-Control-Allow-Origin: *`, never the request's origin, and no `Vary: Origin` is added. |
| A string | The `Origin` header equals it exactly (scheme, host and port, case-sensitive). |
| A string array | The `Origin` header equals one of the entries exactly. |
| A `RegExp` | The pattern matches the whole `Origin` header. `lastIndex` is reset before each test, so `g` and `y` flags are safe. |
| A function | It returns (or resolves to) exactly `true`. Any other value, even a truthy one such as `1` or `{}`, disallows the origin. It receives the origin and the request `Ctx`. |

A RegExp must be anchored and must not have a top-level `|`:

<<< security/cors.ts#regexp

- An unanchored pattern such as `/app\.example/` also matches `https://app.example.evil`, so a
  RegExp whose source does not start with `^` and end with an unescaped `$` is a
  `CorsConfigError`.
- `/^https:\/\/a\.example|https:\/\/b\.example$/` anchors only the start of the first alternative
  and the end of the last, so a `|` outside every group and character class is a
  `CorsConfigError` too. Group the alternatives inside the anchors: `/^(?:a|b)$/`.
- Keep the pattern linear: nested quantifiers such as `(a+)+` backtrack catastrophically on a
  crafted `Origin`. This is not detected for you.

A predicate can look at the request as well as the origin. It runs for every request that sends
an `Origin` header, so keep it cheap; if it throws, the request fails with a 500 like any other
error.

<<< security/cors.ts#predicate

An `Origin` header longer than `MAX_ORIGIN_LENGTH` (2048) characters is treated as disallowed
without consulting the rule, even with `origin: '*'`. A request without an `Origin` header never
gets CORS headers: it is not a cross-origin browser request.

## Requests and responses

### Preflight requests

A preflight is an `OPTIONS` request that carries `Access-Control-Request-Method`. The middleware
answers it with `204 No Content` and an empty body, before rate limiting, routing and guards,
so preflights work on every path, with or without a route. Other `OPTIONS` requests go through to
your routes like any other method.

For an allowed origin, the 204 carries:

| Header | Value |
| --- | --- |
| `Access-Control-Allow-Origin` | The request's origin, or `*` with `origin: '*'`. |
| `Access-Control-Allow-Credentials` | `true`, when `credentials` is set. |
| `Access-Control-Allow-Methods` | `methods`, joined with `, `. |
| `Access-Control-Allow-Headers` | `allowedHeaders` joined with `, `, or the request's `Access-Control-Request-Headers` when `allowedHeaders` is unset (omitted if both are empty). |
| `Access-Control-Max-Age` | `maxAge`, when set. |

A preflight from a disallowed origin is still a 204, but without any `Access-Control-*`
headers, so the browser blocks the real request.

### Simple and actual requests

The request runs normally whether or not its origin is allowed: CORS is enforced by the browser,
not the server. For an allowed origin the response gets `Access-Control-Allow-Origin`, plus
`Access-Control-Allow-Credentials: true` with `credentials` and `Access-Control-Expose-Headers`
with a non-empty `exposedHeaders`. A disallowed origin gets none of them.

> [!IMPORTANT]
> CORS only controls which pages may read responses. It does not stop a request from reaching
> your handler, and it does nothing against clients that are not browsers. Protect state-changing
> routes with authentication and [guards](/guide/guards/).

### `Vary`

Unless `origin` is `'*'`, every response (allowed, disallowed or without an `Origin` header) gets
`Vary: Origin`, so shared caches never serve one origin's answer to another. Preflights also get
`Vary: Access-Control-Request-Headers` when `allowedHeaders` is unset, because the answer then
depends on that header.

`mergeVary(res: Response, values: readonly string[]): Response` is the helper that adds them: it
keeps the response's existing `Vary` values and appends the new ones that are not already there,
comparing case-insensitively. A handler that sets `Vary: Accept-Encoding` ends up with
`Vary: Accept-Encoding, Origin`.

### WebSocket upgrades

Browsers do not apply CORS to WebSockets, so a page on any site could otherwise open a socket
with the user's cookies (cross-site WebSocket hijacking). The middleware therefore rejects an
upgrade request (`Upgrade: websocket`) whose `Origin` is present but not allowed with
`403 Forbidden` (detail `Origin not allowed for WebSocket upgrade`), before the endpoint's
`upgrade()` runs. Upgrades without an `Origin` header come from non-browser clients and are let
through.

`WsRegistry` applies its own same-origin check to every upgrade, independently of this module:
list your cross-origin front ends in the endpoint's `allowedOrigins` as well. See
[WebSockets](/guide/websockets/).

## API reference

### `validateCorsOptions()`

`validateCorsOptions(options: CorsOptions): void` throws a `CorsConfigError` for:

- An `origin` that is not a string, an array of strings, a RegExp or a function (including a
  missing `origin`, or an array with a non-string entry): the message starts with
  `CORS origin must be a string, an array of strings, a RegExp or a function`.
- `'*'` inside an origin array: `Use origin: '*' instead of listing '*' among origins.`
- `origin: '*'` with `credentials: true`: the message starts with
  `CORS origin "*" cannot be combined with credentials: true`.
- A RegExp with a top-level `|`: the message names the pattern and suggests `/^(?:a|b)$/`.
- An unanchored RegExp: the message names the pattern and says it `must be anchored with ^ and $`.
- A `maxAge` that is not a non-negative integer: `CORS maxAge must be a non-negative integer, got …`.

`CorsModule.forRoot()` calls it for you.

### `CorsMiddleware`

The middleware class (`implements Middleware`). It reads its options from `CORS_OPTIONS`.
`CorsModule.forRoot()` registers it; use it directly only if you provide `CORS_OPTIONS` yourself,
and then call `validateCorsOptions()` on the options first, since nothing else does.

### `CORS_OPTIONS`

`InjectionToken<CorsOptions>` holding the options passed to `forRoot()`.

### `CorsConfigError`

Extends `KneadError` from `@knead-js/core`. Thrown by `validateCorsOptions()` and therefore by
`CorsModule.forRoot()`, at startup.

### `MAX_ORIGIN_LENGTH`

`2048`: the longest `Origin` header that is checked against the rule. Longer ones are disallowed.

### `mergeVary()`

See [`Vary`](#vary).
