# @knead-js/cors

[![npm](https://img.shields.io/npm/v/@knead-js/cors?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/cors)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Cross-Origin Resource Sharing for [Knead](https://github.com/quinnjr/knead) applications: a
global middleware that adds CORS headers, answers preflights before routing, and rejects unsafe
configurations at startup.

**[Documentation](https://quinnjr.github.io/knead/packages/cors/)** · [Guide](https://quinnjr.github.io/knead/guide/security/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/http @knead-js/cors
```

Requires Bun 1.4.3 or newer. `@knead-js/core` and `@knead-js/http` are peer dependencies, so every
package shares one copy.

## Quick start

```ts
import { Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { Controller, Get } from '@knead-js/http';

@Controller('/api')
export class ProjectsController {
  @Get('/projects')
  list() {
    return [{ id: 1, name: 'Apollo' }];
  }
}

@Module({
  imports: [
    CorsModule.forRoot({
      origin: ['https://app.example.com', 'https://admin.example.com'],
      credentials: true,
      maxAge: 600,
    }),
  ],
  controllers: [ProjectsController],
})
export class AppModule {}
```

Pages on the two listed origins can call the API with cookies and read the responses. Their
preflights are answered with `204 No Content` and cached by the browser for 10 minutes. Responses
to every other origin carry no CORS headers, so the browser keeps them from the page.

## Features

- **Preflights first.** `OPTIONS` requests with `Access-Control-Request-Method` are answered at
  middleware priority 1000, before rate limiting, routing and guards, on every path.
- **Every response.** 404, 405, guard rejections and errors get CORS headers too, so the browser
  can read the error.
- **Unsafe configurations fail at startup.** `'*'` with credentials, `'*'` inside a list,
  unanchored RegExps, an `origin` of the wrong type (missing, a number, a list with a
  non-string entry), a string origin that can never match (`'https://app.example/'`; the error
  names the canonical `'https://app.example'`) and a non-boolean `credentials` are a
  `CorsConfigError` at `forRoot()`.
- **Cache-safe.** Unless `origin` is `'*'`, every response gets `Vary: Origin`.
- **WebSocket upgrades guarded.** An upgrade from a disallowed origin is rejected with 403.
- **Bounded input.** An `Origin` header longer than 2048 characters is treated as disallowed.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `origin` | required | Which origins are allowed. See [origin rules](#origin-rules). |
| `methods` | `GET, HEAD, PUT, PATCH, POST, DELETE` | Sent as `Access-Control-Allow-Methods` on preflights. |
| `allowedHeaders` | reflect the request | Sent as `Access-Control-Allow-Headers` on preflights. Unset, the preflight's `Access-Control-Request-Headers` is echoed back. |
| `exposedHeaders` | none | Response headers the page may read, sent as `Access-Control-Expose-Headers`. |
| `credentials` | `false` | Sends `Access-Control-Allow-Credentials: true`. Cannot be combined with `origin: '*'`. |
| `maxAge` | none | Seconds a browser may cache a preflight. A non-negative integer. |

## Origin rules

| `origin` | Allowed when |
| --- | --- |
| `'*'` | Any origin. The response says `Access-Control-Allow-Origin: *`, never the request's origin. |
| A string or string array | The `Origin` header equals an entry exactly (scheme, host and port). |
| A `RegExp` | The pattern matches the whole `Origin` header. |
| A function | It returns or resolves to exactly `true` (a truthy non-`true` value disallows). It receives the origin and the request `Ctx`. |

A RegExp must start with `^`, end with `$`, and keep alternatives inside a group. Otherwise
`/app\.example/` would also match `https://app.example.evil`, so both mistakes are rejected:

```ts
export const previewCors: CorsOptions = {
  // Anchored with ^ and $; alternatives grouped inside the anchors.
  origin: /^https:\/\/(?:[a-z0-9-]+\.)?preview\.example\.com$/,
};
```

Keep the pattern linear: nested quantifiers such as `(a+)+` backtrack catastrophically on a
crafted `Origin`, and this is not detected for you.

A predicate can look at the whole request. It runs for every request with an `Origin` header,
preflights included, so keep it cheap. Browsers never send your own headers on a preflight, so
check them only on the actual request:

```ts
const tenants = new Set(['https://acme.example.com', 'https://globex.example.com']);

// Browsers never send author headers such as x-tenant on a preflight, so the predicate
// requires the header only on the actual request.
const isPreflight = (ctx: Ctx) =>
  ctx.req.method === 'OPTIONS' && ctx.req.headers.has('access-control-request-method');

export const tenantCors: CorsOptions = {
  origin: (origin: string, ctx: Ctx) =>
    tenants.has(origin) && (isPreflight(ctx) || ctx.req.headers.get('x-tenant') !== null),
  allowedHeaders: ['content-type', 'authorization', 'x-tenant'],
  methods: ['GET', 'POST'],
};
```

## What CORS does not do

- **It does not block requests.** A request from a disallowed origin still reaches your handler;
  CORS only controls which pages may read the response, and it does nothing against clients that
  are not browsers. Protect state-changing routes with authentication and guards.
- **Disallowed preflights still get a 204**, without any `Access-Control-*` headers, so the browser
  blocks the real request.
- **Requests without an `Origin` header** never get CORS headers.

## WebSocket upgrades

Browsers do not apply CORS to WebSockets, so a page on any site could otherwise open a socket with
the user's cookies. The middleware rejects an upgrade whose `Origin` is present but not allowed
with `403 Forbidden`, before the endpoint's `upgrade()` runs. Upgrades without an `Origin` header
come from non-browser clients and are let through.

`WsRegistry` in `@knead-js/http` also accepts only same-origin upgrades unless the endpoint lists
more, so add your cross-origin front ends to the endpoint's `allowedOrigins` as well.

## Documentation

- [`@knead-js/cors` reference](https://quinnjr.github.io/knead/packages/cors/): options, headers,
  `Vary` handling and every export.
- [Security guide](https://quinnjr.github.io/knead/guide/security/): how CORS fits with security
  headers and rate limiting.
- [Middleware guide](https://quinnjr.github.io/knead/guide/middleware/): global middleware and
  priorities.
- [WebSockets guide](https://quinnjr.github.io/knead/guide/websockets/): `allowedOrigins` and the
  same-origin check.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
