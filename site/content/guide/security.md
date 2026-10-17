---
title: Security
description: What Knead protects by default, how the CORS, security-header and rate-limit modules fit together, and what to configure before going to production.
---

Knead is secure by default: request limits, input hardening, masked production errors and
fail-closed guards are on without any configuration, and the settings that would weaken them are
explicit opt-ins. Three optional packages add the browser-facing layer:
[`@knead-js/cors`](/packages/cors/), [`@knead-js/security-headers`](/packages/security-headers/)
and [`@knead-js/rate-limit`](/packages/rate-limit/). [`@knead-js/sanitize`](/packages/sanitize/)
cleans untrusted HTML.

This page explains each default and the reasoning behind it, then shows a hardened application
and a checklist for production.

## What is on by default

### Request limits

Every input path has a bound, so one client cannot make the server buffer or parse unbounded data:

| Limit | Default | Over the limit | Option |
| --- | --- | --- | --- |
| Request body size | 1 MiB | `413` | `listen({ maxRequestBodySize })` |
| Query parameters | 1000 | `400` | `listen({ maxParams })` |
| urlencoded or multipart body fields | 1000 | `413` | `listen({ maxParams })` |
| WebSocket message size | 256 KiB | connection dropped | `listen({ websocket: { maxPayloadLength } })` |
| WebSocket buffered output (backpressure) | 1 MiB | socket closed | `listen({ websocket: { backpressureLimit } })` |
| WebSocket idle time | 120 s | socket closed | `listen({ websocket: { idleTimeout } })` |
| WebSockets per client IP | 100 | `429` | `listen({ websocket: { maxConnectionsPerIp } })` |
| WebSocket messages per socket | 100 per 10 s | socket closed with 1008 | `listen({ websocket: { messageRate } })` |

Field counts are checked before the parser builds the fields, so an oversized query string or form
is rejected without being parsed. GraphQL adds its own bounds on every operation: depth 10,
complexity 1000, 3000 tokens, 100 KiB of query text, 30 aliases, 1000 fields and an introspection
depth of 20. See [server](/guide/server/), [WebSockets](/guide/websockets/) and
[GraphQL](/guide/graphql/).

Raise a limit deliberately when a route needs it. Do not disable one in production.

### Untrusted input

- **Prototype pollution.** Query strings, urlencoded and multipart bodies are parsed into objects
  without a prototype, and the keys `__proto__`, `constructor` and `prototype` are dropped. JSON
  bodies drop `__proto__` at every depth, and `constructor` and `prototype` when they hold an
  object. Still, never `Object.assign()` request data onto your own objects: copy the fields you
  expect, ideally after a [validation](/guide/validation/) schema has checked them.
- **Content types.** A body is parsed only as JSON (`application/json` or `+json`), urlencoded,
  multipart or text. Any other declared type is a `415`, and malformed JSON is a `400`.
- **Validation messages.** Issues found by a `headers` schema always get the generic message
  `Invalid header value`, because header schemas tend to quote tokens and cookies.
  `listen({ validation: { redactIssueMessages: true } })` does the same (`Invalid value`) for
  body, query and params issues.

### Hosts and proxies

- **Host validation.** `listen({ allowedHosts })` lists the host names the server answers to. A
  request for any other `Host` gets `421 Misdirected Request` before middleware, routes and
  WebSocket upgrades run, which defeats DNS rebinding. In development the default is `localhost`,
  `127.0.0.1`, `[::1]` and the bound hostname; in production there is no default, because the
  public names are not known, so set it yourself.
- **Proxies.** `trustProxy` is off by default: `X-Forwarded-For` and `X-Forwarded-Proto` are
  ignored, and `ctx.ip` and `ctx.secure` come from the socket. A request that carries
  `X-Forwarded-*` headers while `trustProxy` is off logs one warning, since that usually means a
  proxy you forgot to configure. Behind a proxy, set `trustProxy` to the proxy CIDRs (preferred)
  or the exact hop count. A hop count on a server that listens on every interface logs a warning,
  because a client that reaches the port directly could choose its own `ctx.ip`.

`ctx.ip` feeds the rate limiter and the WebSocket per-IP limit, and `ctx.secure` decides whether
HSTS is sent, so a wrong `trustProxy` weakens all three. See [server](/guide/server/) and
[request context](/guide/request-context/).

### Errors and logs

- **Masked 5xx responses.** Outside development, a 5xx response carries only `type`, `title`,
  `status`, `instance` and a `correlationId`: no message, stack or extensions, which tend to
  reveal internals. The same id is in the log line, so you can find the details. 4xx responses
  keep their `detail`, which is your own message.
- **Development mode** shows error details (redacted) in 500 responses. It is on only when
  `NODE_ENV === 'development'` or you pass `development: true` to `KneadFactory.create()`, and
  `listen()` warns when development mode runs on an address reachable from other hosts.
- **Logs.** Outside development an error is logged as `Name: message` only, without the stack,
  cause or properties. Credentials are redacted everywhere: URL userinfo
  (`redis://***@host`), secret `key=value` pairs (`password=`, `token=`, `api_key=` and similar),
  `Bearer` and `Basic` credentials, and sensitive keys in nested objects. See
  [logging](/guide/logging/).

### Fail-closed guards

A guard passes only when it returns or resolves to exactly `true`. `1`, `'yes'`, an object or a
promise of `'true'` is a `403`. A guard that throws turns into that error's response. So a guard
with a bug, such as one that forgets to `return`, denies access instead of granting it. See
[guards](/guide/guards/) and [authorization](/guide/authorization/).

GraphQL follows the same rule: playground, introspection and unmasked errors are on only in
development, and GET operations must carry an `x-graphql-request` header so a cross-site form or
image cannot trigger them.

### Linear parsing

The framework's own parsers and regular expressions (body and query parsing, host and proxy
header handling, log redaction) run in time linear in their input, so crafted input cannot stall
the event loop. Patterns you supply, such as a CORS `origin` RegExp, must be linear too: avoid
nested quantifiers like `(a+)+`.

## The security modules

Each module registers global middleware with a fixed priority. Global middleware runs outermost
first, in descending priority, before any module, controller or route middleware and before
guards:

```text
request
  -> Host check (421)                     listen({ allowedHosts })
  -> SecurityHeadersModule   priority 1100
  -> CorsModule              priority 1000  (answers preflights here)
  -> RateLimitModule         priority  900  (answers 429 here)
  -> your global middleware  priority    0  (default)
  -> module, controller and route middleware
  -> guards -> validation -> authorize guards -> handler
```

Every layer turns its own errors into a response, and the layers outside it still see that
response. The order therefore gives you:

- Security headers on every response, including CORS preflights, 429s, 404s and errors raised by
  the inner layers. The 421 from the host check is the exception: it is answered before any
  middleware.
- CORS headers on 429s and errors, so a browser app can read them, and preflights that are never
  counted against a rate limit.
- Rate limiting before routing work, guards and validation. The middleware's key function cannot
  see what a guard stores (such as the authenticated user); `RateLimitGuard` counts in the guard
  phase for per-user limits.

Your own global middleware registered with `APP_MIDDLEWARE` or `app.useGlobalMiddleware()` gets
priority 0 unless you pass one; give it a priority above 1100 to wrap the security modules, for
example to log every response. See [middleware](/guide/middleware/).

## A hardened application

The three modules together, with a stricter limit on the login route:

<<< security/hardened-app.ts#module title="app.module.ts"

And the listener options that matter in production:

<<< security/hardened-main.ts#listen title="main.ts"

With this setup:

- every response carries a strict CSP, HSTS (once the proxy reports HTTPS), `nosniff`,
  `X-Frame-Options: DENY` and the other headers listed in
  [security headers](/packages/security-headers/);
- only `https://app.example.com` can read responses with credentials, and a WebSocket upgrade
  from another origin is a 403;
- each client IP gets 300 requests a minute, plus 5 login attempts per 15 minutes on their own
  counter, and the health check is never limited;
- requests for any other host than `api.example.com` are refused with 421.

Behind several app instances, give `RateLimitModule` a `RedisStore`, or each instance counts
separately. See [rate limit](/packages/rate-limit/).

## Untrusted HTML

When you accept HTML to render back (comments, rich-text fields), clean it with
[`@knead-js/sanitize`](/packages/sanitize/) before storing or rendering it: `sanitize()` or the
`sanitizedHtml()` schema keep only an allowlist of tags, attributes and URL schemes, and refuse
policies that would re-enable script. Combined with a strict Content Security Policy, an injected
script neither survives sanitizing nor runs if something slips through.

## Production checklist

- [ ] `NODE_ENV` is not `development`, and `development` is not forced to `true`.
- [ ] `listen({ allowedHosts })` lists your public host names, plus the `Host` your load
      balancer's health checks send (often an internal name or IP), or they get 421.
- [ ] Behind a proxy or load balancer, `trustProxy` is the proxy CIDRs or the exact hop count, and
      the app port is reachable only through the proxy.
- [ ] TLS is terminated by the app (`tls`, optionally `redirectHttp` with a canonical `host`) or by
      a trusted proxy that sets `X-Forwarded-Proto`, so `ctx.secure` is true and HSTS is sent.
- [ ] `SecurityHeadersModule.forRoot()` is installed; any CSP relaxation is per route, and inline
      scripts use the nonce instead of `'unsafe-inline'`.
- [ ] HSTS `maxAge` is at least 180 days; `preload` only once every subdomain serves HTTPS.
- [ ] `CorsModule` lists explicit origins (or anchored RegExps) and never combines `'*'` with
      credentials; WebSocket endpoints list cross-origin front ends in `allowedOrigins`.
- [ ] `RateLimitModule` uses a `RedisStore` when there is more than one process, connected over
      `rediss://` with `requireTls: true`, a `hashSecret` and a least-privilege ACL user.
- [ ] Authentication routes have their own `@RateLimit()` and `onStoreError: 'deny'`.
- [ ] Health checks have `@SkipRateLimit()`, and CORS `exposedHeaders` include the `RateLimit-*`
      and `Retry-After` headers if browser code reads them.
- [ ] Request limits (body size, `maxParams`, WebSocket and GraphQL limits) are at their defaults
      or raised deliberately, never disabled.
- [ ] Every route that changes data has a guard; for GraphQL consider `defaultDeny: true`.
- [ ] HTML from users goes through `sanitize()` or `sanitizedHtml()`.
- [ ] `defaultCacheControl: 'no-store'` (or a per-route `Cache-Control`) for responses with
      per-user data.
- [ ] Logs go through `LOGGER`, never `console.*`, so redaction applies.

Report vulnerabilities in Knead itself privately, as described in the repository's
[security policy](https://github.com/quinnjr/knead/security/policy).
