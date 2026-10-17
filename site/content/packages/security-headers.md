---
title: Security headers
description: Strict Content-Security-Policy, HSTS and the other browser hardening headers on every response, with per-request nonces and per-route overrides.
---

```bash
bun add @knead-js/core @knead-js/http @knead-js/security-headers
```

`@knead-js/core` and `@knead-js/http` are peer dependencies, so every package shares one copy.

`@knead-js/security-headers` sets the response headers that tell browsers to lock a page down: a
strict Content Security Policy, HTTP Strict Transport Security on secure requests, `nosniff`,
frame and referrer policies, cross-origin isolation headers and a Permissions-Policy. Everything is
on by default, so `SecurityHeadersModule.forRoot()` with no options is a good start. You relax what
you need, globally or per route. For how it fits with CORS and rate limiting, see
[security](/guide/security/).

## `SecurityHeadersModule`

`SecurityHeadersModule.forRoot(options: SecurityHeadersOptions = {}): DynamicModule` validates the
options with `validateSecurityHeadersOptions()` and returns a global module that provides
`SECURITY_HEADERS_OPTIONS`, `SecurityHeadersMiddleware` and an `APP_MIDDLEWARE` entry with
priority 1100. Import it once, in the root module.

<<< security/security-headers-defaults.ts#module title="app.module.ts"

Priority 1100 makes it the outermost of the security modules (CORS is 1000, rate limiting 900), so
CORS preflight answers, 429 responses and errors raised by those layers carry the headers too, as
do 404, 405 and 500 responses.

The middleware never overwrites a header the response already has: if a handler sets its own
`Content-Security-Policy` or `X-Frame-Options`, that value is kept.

## Default headers

`DEFAULT_OPTIONS` holds the defaults. Your options are merged over them with `mergeOptions()`.

| Header | Option | Default value |
| --- | --- | --- |
| `Content-Security-Policy` | `contentSecurityPolicy` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests` |
| `Strict-Transport-Security` | `strictTransportSecurity` | `max-age=31536000; includeSubDomains`, on secure requests only |
| `X-Content-Type-Options` | `xContentTypeOptions` | `nosniff` |
| `Referrer-Policy` | `referrerPolicy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `crossOriginOpenerPolicy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `crossOriginResourcePolicy` | `same-origin` |
| `X-Frame-Options` | `xFrameOptions` | `DENY` |
| `X-DNS-Prefetch-Control` | `xDnsPrefetchControl` | `off` |
| `Permissions-Policy` | `permissionsPolicy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| `X-Permitted-Cross-Domain-Policies` | `xPermittedCrossDomainPolicies` | `none` |

Set any option to `false` to drop that header.

## `SecurityHeadersOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `contentSecurityPolicy` | `CspOptions` or `false` | the default policy | See [Content Security Policy](#content-security-policy). |
| `strictTransportSecurity` | `HstsOptions` or `false` | `{ maxAge: 31536000, includeSubDomains: true }` | See [HSTS](#hsts). |
| `xContentTypeOptions` | `'nosniff'` or `false` | `'nosniff'` | Stops browsers from guessing content types. |
| `referrerPolicy` | `string` or `false` | `'no-referrer'` | The `Referrer-Policy` value. |
| `crossOriginOpenerPolicy` | `string` or `false` | `'same-origin'` | The `Cross-Origin-Opener-Policy` value. |
| `crossOriginResourcePolicy` | `string` or `false` | `'same-origin'` | The `Cross-Origin-Resource-Policy` value. Use `'cross-origin'` for assets other sites embed. |
| `xFrameOptions` | `'DENY'`, `'SAMEORIGIN'` or `false` | `'DENY'` | Legacy framing control; CSP `frame-ancestors` is the modern one. |
| `xDnsPrefetchControl` | `'on'`, `'off'` or `false` | `'off'` | DNS prefetching of links on the page. |
| `permissionsPolicy` | `string` or `false` | `'camera=(), microphone=(), geolocation=(), interest-cohort=()'` | The `Permissions-Policy` value. |
| `xPermittedCrossDomainPolicies` | `'none'`, `'master-only'`, `'by-content-type'`, `'all'` or `false` | `'none'` | Flash and PDF cross-domain policy files. |

Each of these values must be a string (or `false`) without control characters other than tab.
Anything else, such as a value containing a line break, is an `HttpConfigError` at startup that
names the header: `Invalid Referrer-Policy: "no-referrer\r\nX-Injected: 1"`.

## Content Security Policy

`CspOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `directives` | `CspDirectives` | `DEFAULT_CSP_DIRECTIVES` | Merged over the defaults (or over the module's directives, for a route override). |
| `reportOnly` | `boolean` | `false` | Sends `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy` (never both). |
| `nonce` | `boolean` or `{ scripts?: boolean; styles?: boolean }` | `false` | Per-request nonces. `true` means scripts only; in the object form `scripts` defaults to `true` and `styles` to `false`. |

`CspDirectives` is `Record<string, readonly string[] | string | boolean>`, and
`DEFAULT_CSP_DIRECTIVES` is:

```json
{
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "upgrade-insecure-requests": true
}
```

Each directive value is one of:

- an array of sources, joined with spaces (`["'self'", 'https://cdn.example.com']`);
- a string, split on whitespace (`"'self' https://cdn.example.com"`);
- `true`, a directive without a value (`upgrade-insecure-requests`);
- `false`, which removes the directive, including a default one.

Directives are emitted in insertion order: the defaults first, then the ones you add. Remember
the quotes CSP requires around keywords: `"'self'"`, not `'self'`.

<<< security/security-headers.ts#module title="app.module.ts"

With these options the policy is the default one plus
`img-src 'self' https://cdn.example.com; connect-src 'self' https://api.example.com; script-src 'self' 'nonce-…'`.

### Nonces

With `nonce` enabled, each request gets a fresh nonce from `generateNonce()`, stored in
`ctx.state.cspNonce` before the rest of the pipeline runs and appended to the policy as
`'nonce-<value>'`. Put it on your inline `<script>` (and, with `styles: true`, `<style>`) tags:

<<< security/security-headers.ts#page title="pages.controller.ts"

The package augments `CtxState` with `cspNonce?: string`, so `ctx.state.cspNonce` is typed. It is
`undefined` when the effective policy has no nonce, or has been disabled.

Where the nonce goes:

- `script-src` (and `style-src` with `styles: true`) gets the nonce appended to its sources.
- If that directive is not set, it is created from the `default-src` sources plus the nonce, so
  the defaults give `script-src 'self' 'nonce-…'`.
- If neither the directive nor a `default-src` source list exists, the directive is the nonce
  alone: only scripts carrying the nonce may run.

### Directive validation

`validateSecurityHeadersOptions()` rejects, with an `HttpConfigError`:

- directive names that are not lowercase letters, digits and hyphens starting with a letter
  (`Script-Src` is rejected);
- values that are not a string, a string array or a boolean, and array elements that are not
  strings;
- any source containing `;`, `,`, a carriage return or a line feed, which could inject another
  directive or header;
- array elements that contain whitespace (each element is one source; use a string to give
  several at once).

## HSTS

`HstsOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | `31536000` (one year) | Seconds. A non-negative integer. `0` tells browsers to forget the policy. |
| `includeSubDomains` | `boolean` | `true` | Appends `; includeSubDomains`. |
| `preload` | `boolean` | `false` | Appends `; preload`. Requires `includeSubDomains` and a `maxAge` of at least 31536000, as the preload list does. |

The header is only sent on secure requests (`ctx.secure`): a TLS listener, or a trusted proxy
that reported `X-Forwarded-Proto: https`. Behind a TLS-terminating proxy or load balancer the app
itself sees plain HTTP, so set `listen({ trustProxy })` to the proxy hop count or CIDRs, or HSTS is
never sent. Do not trust more hops than there are proxies, or a client could claim `https` itself.
See [server](/guide/server/).

A `maxAge` from 1 to 15551999 seconds is allowed but logs one warning through `LOGGER`, because
browsers then forget the policy quickly and the downgrade window reopens.
`MIN_RECOMMENDED_HSTS_MAX_AGE` is that threshold, `15552000` (180 days). `maxAge: 0` and
`strictTransportSecurity: false` do not warn. The warning is logged at most once per application:
when the middleware is created, or the first time a route override with a short `maxAge` is used.

## Per-route overrides

`SecurityHeaders(options: SecurityHeadersOptions)` is a class or method decorator. It validates
the options when it is applied (so a bad override fails at import time) and stores them in route
metadata under `SECURITY_HEADERS_META`. The middleware merges them over the module options with
`mergeOptions()` for requests to that route:

- options you leave out keep the module's value;
- `false` drops a header for that route;
- `contentSecurityPolicy.directives` merge over the module's directives, one directive at a time;
- `strictTransportSecurity` fields merge over the module's HSTS fields.

The `/widget` route in the example above allows framing by one partner site: it replaces
`frame-ancestors`, drops `X-Frame-Options`, and keeps every other directive, the nonce and all
other headers.

> [!NOTE]
> A method decorator replaces a controller decorator: the two are not merged with each other. If
> the controller has `@SecurityHeaders({ referrerPolicy: 'same-origin' })` and a method has
> `@SecurityHeaders({ xFrameOptions: 'SAMEORIGIN' })`, that method's responses use the module's
> `Referrer-Policy`. Repeat the controller's options on the method when you need both.

Unmatched requests (404 and 405) use the module options.

## Functions

### `mergeOptions()`

`mergeOptions(a: SecurityHeadersOptions, b: SecurityHeadersOptions): SecurityHeadersOptions`
returns `a` with every option that `b` defines (not `undefined`) replaced, except:

- `contentSecurityPolicy`: `b`'s `false` disables it; an object is spread over `a`'s object and
  its `directives` over `a`'s directives. If `a` has no policy (or `false`), `b` is merged over
  `DEFAULT_CSP_DIRECTIVES`, so re-enabling CSP on a route starts from the strict defaults.
- `strictTransportSecurity`: `b`'s `false` disables it; an object is spread over `a`'s.

### `buildHeaders()`

`buildHeaders(options: SecurityHeadersOptions, request: { secure: boolean; nonce?: string | undefined }): [string, string][]`
returns the header names (lowercase) and values for one response, in the order of the table
above. HSTS is included only when `request.secure` is `true`; the nonce only when the policy
enables nonces.

### `serializeCsp()`

`serializeCsp(directives: CspDirectives, nonce?: string, targets?: NonceTargets): string` renders
a policy: directives joined with `; `, `false` ones skipped, `true` ones as a bare name. With a
`nonce`, the target directives are extended as described in [nonces](#nonces). `targets` defaults
to `{ scripts: true, styles: false }`.

### `nonceTargets()`

`nonceTargets(csp: CspOptions | false | undefined): NonceTargets | undefined` reads the `nonce`
option: `undefined` when nonces are off, otherwise `NonceTargets`, the interface
`{ scripts: boolean; styles: boolean }`.

### `generateNonce()`

`generateNonce(): string` returns 16 random bytes from `crypto.getRandomValues()`, base64-encoded.

### `validateSecurityHeadersOptions()`

`validateSecurityHeadersOptions(options: SecurityHeadersOptions): void` throws an `HttpConfigError`
(from `@knead-js/http`) for invalid CSP directives (see [directive validation](#directive-validation)),
an HSTS `maxAge` that is not a non-negative integer, `preload` with `includeSubDomains: false` or a
`maxAge` under one year, and a header option (`referrerPolicy`, `crossOriginOpenerPolicy`,
`crossOriginResourcePolicy`, `xContentTypeOptions`, `xFrameOptions`, `xDnsPrefetchControl`,
`permissionsPolicy`, `xPermittedCrossDomainPolicies`) that is neither `false` nor a string without
control characters other than tab.
`forRoot()`, `@SecurityHeaders()` and the middleware's constructor all call it.

## Classes and tokens

### `SecurityHeadersMiddleware`

The middleware class (`implements Middleware`). It merges `DEFAULT_OPTIONS` with the options in
`SECURITY_HEADERS_OPTIONS`, validates the result, and on each request applies the route override,
generates the nonce and adds the headers after the rest of the pipeline has produced a response.
Merged route options are cached per override.

### `SECURITY_HEADERS_OPTIONS`

`InjectionToken<SecurityHeadersOptions>` holding the options passed to `forRoot()`.

### `SECURITY_HEADERS_META`

The route metadata key (`Symbol('knead:security-headers')`) under which `@SecurityHeaders()`
stores its options.

### `DEFAULT_OPTIONS` and `DEFAULT_CSP_DIRECTIVES`

The defaults listed in [default headers](#default-headers).
