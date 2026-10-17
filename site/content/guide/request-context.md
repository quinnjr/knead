---
title: Request context
description: The Ctx object every handler, guard and middleware receives, how its fields are typed and parsed, and the limits that protect it.
---

Every handler, guard, middleware and exception filter receives the same object for a request: the
context, typed `Ctx`. It wraps Bun's `Request` and adds parsed parameters, query, headers and body,
the client address, the matched route, per-request state and a draft of the response.

<<< http/request-context.ts#inspect title="inspect.controller.ts"

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `req` | `Request` | The original Bun request. |
| `params` | `Record<string, string>` | Path parameters, percent-decoded. Replaced by the output of a `params` schema. |
| `query` | `Record<string, string \| string[]>` | Query parameters, parsed on first access. Replaced by the output of a `query` schema. |
| `headers` | `Record<string, string>` | Request headers with lowercase names, built on first access. Replaced by the output of a `headers` schema. |
| `body` | `unknown` | `undefined` unless the route has a `body` schema, in which case it is the validated body. |
| `json()` | `<T>() => Promise<T>` | Parses the body by `Content-Type`, once. |
| `ip` | `string \| undefined` | The client address, honoring `listen({ trustProxy })`. |
| `secure` | `boolean` | `true` on a TLS listener, or when a trusted proxy reported `X-Forwarded-Proto: https`. |
| `route` | `RouteInfo \| null` | The matched route, or `null`. |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | The route's metadata, or an empty frozen object. |
| `upgrade` | `UpgradeInfo \| null` | `{ path }` on a WebSocket upgrade to a registered endpoint, `null` otherwise. |
| `state` | `CtxState & Record<PropertyKey, unknown>` | A fresh object per request, for middleware and guards to share data. |
| `res` | `ResponseDraft` | The response draft: `status` and `headers`. |
| `server` | `Server` | The Bun server that received the request. |

`params`, `query`, `headers` and `body` are writable, which is how validation replaces them with
the schema output. The rest are read-only.

## Typing the context

`Ctx` takes one type argument describing the inputs: `Ctx<{ params?, query?, body?, headers? }>`
(the shape is `CtxInput`). Each key you leave out keeps its default type from the table above, and
`Ctx` alone is `Ctx<{}>`.

The route decorators check the handler's `ctx` type against the route. For each input, the route
supplies:

| Input | Without a schema | With a schema |
| --- | --- | --- |
| `params` | the names in the path, as strings (`PathParams<'/cats/:id'>` is `{ id: string }`) | the schema's output type |
| `query` | `Record<string, string \| string[]>` | the schema's output type |
| `headers` | `Record<string, string>` | the schema's output type |
| `body` | `undefined` | the schema's output type |

A handler whose `ctx` type asks for more than the route supplies does not compile. For example,
`Ctx<{ body: { title: string } }>` on a route without a `body` schema is a type error, because
`ctx.body` is `undefined` there at runtime. Read an unvalidated body with `await ctx.json()`
instead, or add a schema (see [validation](/guide/validation/)).

## Path parameters

`ctx.params` comes from Bun's router: one string per `:name` segment, percent-decoded. A wildcard's
match is not included, and requests answered by the fallback (404 and 405) have `{}`. See
[paths and parameters](/guide/controllers/).

## Query parameters

`ctx.query` is parsed from the URL the first time you read it:

- A key that appears once is a string; a repeated key is an array of strings in order
  (`?tag=a&tag=b` gives `{ tag: ['a', 'b'] }`). Type your code for both, or validate the query.
- The object has a `null` prototype, and the keys `__proto__`, `constructor` and `prototype` are
  dropped, so the object never carries inherited or prototype-changing properties.
- More than `maxParams` parameters (default 1000) is a `400 Bad Request` with the detail
  `The query string has more than 1000 parameters.`. The raw query string is counted before it is
  parsed, so a huge query costs no more than the count.

## Headers

`ctx.headers` is a `null`-prototype object of the request headers with lowercase names. A header
sent several times has its values joined with `, `, as `Headers.get()` does. For the `Headers`
object itself, use `ctx.req.headers`.

## The request body

`ctx.json()` reads and parses the body according to its `Content-Type` (matched case-insensitively,
parameters such as `; charset=utf-8` ignored). It is memoized: every call for a request returns the
same promise, so middleware, guards and the handler can all call it.

<<< http/request-context.ts#body title="notes.controller.ts"

| `Content-Type` | Result |
| --- | --- |
| `application/json`, or any `+json` type such as `application/merge-patch+json` | The parsed JSON, with unsafe keys removed (see [prototype pollution](#prototype-pollution)). An empty body is `undefined`. |
| `application/x-www-form-urlencoded` | A `null`-prototype object of strings; repeated fields become arrays. |
| `multipart/form-data` | A `null`-prototype object of strings and `File`s; repeated fields become arrays. |
| `text/*` | The body as a string. |
| any other type | `415 Unsupported Media Type` (`Unsupported content type: application/xml`), without reading the body. |
| none, with a non-empty body | `415 Unsupported Media Type` (`Unsupported content type: (none)`). |
| none, with an empty body, or a request without a body | `undefined` |

Parse failures are client errors: malformed JSON is a `400` with the detail `Malformed JSON body`,
an unparseable multipart body is a `400` with `Malformed multipart body`, and a body that cannot be
read is a `400` with `Failed to read request body`.

`ctx.json<T>()` does not check the type argument: `T` is only a cast. Validate bodies you rely on
with a `body` schema; then `ctx.json()` resolves to the validated value too, so unvalidated fields
cannot slip back in through it.

> [!WARNING]
> Read the body only through `ctx.json()`. A body can be read once, so after middleware calls
> `ctx.req.text()` or `ctx.req.json()` itself, `ctx.json()` (and a `body` schema) fails with
> `400 Failed to read request body`.

## Limits

Every request is bounded before your code sees it. The limits are set on `listen()`:

| Option | Default | Over the limit |
| --- | --- | --- |
| `maxRequestBodySize` | 1 MiB (`1048576` bytes) | Bun answers `413` with an empty body, before any middleware runs. |
| `maxParams` | `1000` (`DEFAULT_MAX_PARAMS`) | More query parameters: `400`, `The query string has more than 1000 parameters.` More urlencoded or multipart fields: `413`, `The request body has more than 1000 fields.` |

Both parameter counts are taken before parsing: a query string or urlencoded body is counted by its
non-empty `&`-separated fields, and a multipart body by its boundary delimiters, so oversized input
is rejected without building it. `maxParams` must be an integer of at least 1; anything else makes
`listen()` reject with `HttpConfigError: maxParams must be an integer >= 1, got 0.`. See
[the server](/guide/server/) for the other `listen()` options.

## Prototype pollution

Parsed request data never carries keys that would change an object's prototype when merged into
it:

- Query strings, urlencoded forms and multipart forms drop the keys `__proto__`, `constructor` and
  `prototype`, and are `null`-prototype objects.
- JSON bodies drop `__proto__` keys at every depth, and drop `constructor` and `prototype` keys
  whose value is an object (a `constructor` key holding a string is kept). Keys spelled with
  `\u` escapes, such as `"__proto__"`, are dropped the same way.

So `Object.assign(entity, await ctx.json())` cannot change `entity`'s prototype. It can still set
any other property, so validate the body and copy only the fields you expect.

The filtering pass runs only when the body text contains `__proto__`, `constructor` or
`prototype`, or a `\u00XX` escape of a printable ASCII character; any other body gets a plain
`JSON.parse`. A legitimate field named `constructor` or `prototype` that holds an object is dropped
as well, so rename such fields in your API.

## Per-request state

`ctx.state` starts as an empty object for each request. Middleware and guards put what they learn
there (the authenticated user, a tenant, a request id), and later layers read it. Type it once for
the whole application by augmenting the `CtxState` interface:

<<< http/request-context.ts#state-type title="ctx-state.d.ts"

<<< http/request-context.ts#state-middleware title="tenant.middleware.ts"

Make the properties optional: a property is only there once the middleware that sets it has run,
and routes outside that middleware never see it.

## The response draft

`ctx.res` is a `ResponseDraft`: `{ status: number | undefined; headers: Headers }`. Set
`ctx.res.status` to override the route's status for this request, and add headers with
`ctx.res.headers`. Both apply to the response built from the handler's return value, and the
headers also fill in what a returned `Response` lacks (see
[return values](/guide/controllers/)).

The draft does not apply to error responses: when the handler throws, the problem response carries
only the headers of the `HttpException` (its `headers` option). Put headers that an error response
needs, such as `Retry-After`, on the exception.

## Route, metadata and upgrades

`ctx.route` is a frozen `RouteInfo` for the matched route:

| Property | Type | Description |
| --- | --- | --- |
| `method` | `HttpMethod` | The route's method, for example `'GET'`. |
| `path` | `string` | The route's path pattern, for example `'/inspect/:id'`. |
| `controller` | `Type` | The controller class. |
| `handler` | `string \| symbol` | The handler method's name. |
| `meta` | `Readonly<Record<PropertyKey, unknown>>` | The route's metadata. |

It is `null` for requests answered by the fallback (404, 405) and for WebSocket upgrades to an
endpoint that has no `GET` route on its path. An upgrade to the path of a `GET` route has that
route as `ctx.route`.

`ctx.meta` is `ctx.route.meta`, or an empty frozen object when there is no route. On a WebSocket
upgrade it is the endpoint's `meta` merged over the route's. `ctx.upgrade` is `{ path }` on an
upgrade request to a registered endpoint and `null` on every other request, so a guard can tell
the two apart. See [WebSockets](/guide/websockets/).

## Client address and TLS

`ctx.ip` is the socket peer's address in canonical form (IPv4-mapped IPv6 becomes IPv4, IPv6 is
lowercased and compressed), or a trusted proxy's `X-Forwarded-For` entry when
`listen({ trustProxy })` is set. `ctx.secure` is `true` on a TLS listener, or when a trusted proxy
sent `X-Forwarded-Proto: https`. With `trustProxy` off (the default), forwarding headers are
ignored. See [the server](/guide/server/) for how proxies are trusted.

## The request URL

Use `requestUrl(ctx.req)` rather than `new URL(ctx.req.url)` to get the URL as a `URL`. Bun gives
a request whose `Host` header does not form a valid URL (such as `Host: a b`) a relative
`req.url`, on which `new URL()` throws; `requestUrl()` resolves it against the placeholder origin
`http://host.invalid` instead, so the path and query are always available.

See the [`@knead-js/http` reference](/packages/http/) for the full `Ctx` type.
