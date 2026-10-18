# @knead-js/security-headers

[![npm](https://img.shields.io/npm/v/@knead-js/security-headers?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/security-headers)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

Browser hardening headers for [Knead](https://github.com/quinnjr/knead) applications: a strict
Content Security Policy, HSTS, `nosniff`, framing, referrer, cross-origin and permissions policies
on every response, with per-request nonces and per-route overrides.

**[Documentation](https://quinnjr.github.io/knead/packages/security-headers/)** · [Guide](https://quinnjr.github.io/knead/guide/security/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/http @knead-js/security-headers
```

Requires Bun 1.4.3 or newer. `@knead-js/core` and `@knead-js/http` are peer dependencies, so every
package shares one copy.

## Quick start

```ts
import { Module } from '@knead-js/core';
import { Controller, Get } from '@knead-js/http';
import { SecurityHeadersModule } from '@knead-js/security-headers';

@Controller('/')
export class StatusController {
  @Get('/status')
  status() {
    return { ok: true };
  }
}

@Module({
  imports: [SecurityHeadersModule.forRoot()],
  controllers: [StatusController],
})
export class AppModule {}
```

Every response now carries the [default headers](#default-headers). Relax what you need, globally
or per route.

## Features

- **Secure by default.** `forRoot()` with no options sends a strict policy for every header.
- **Every response.** The middleware runs at priority 1100, outside CORS (1000) and rate limiting
  (900), so preflights, 429s, 404s, 405s and 500s carry the headers too.
- **CSP nonces.** A fresh nonce per request in `ctx.state.cspNonce`, added to `script-src` (and
  optionally `style-src`).
- **Per-route overrides.** `@SecurityHeaders()` on a controller or method merges over the module
  options.
- **HSTS done right.** Sent only on secure requests, validated against the preload list rules.
- **Validated at startup.** Malformed directives and header values are an `HttpConfigError`
  before the server starts.
- **Handlers win.** A header the response already has is never overwritten.

## Default headers

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

Set an option to `false` to drop that header. The string options take the header's value.

## Content Security Policy

`directives` merge over the defaults, one directive at a time. A directive value is an array of
sources, a whitespace-separated string, `true` for a directive without a value, or `false` to
remove it. Remember the quotes CSP requires around keywords: `"'self'"`, not `'self'`.

```ts
@Module({
  imports: [
    SecurityHeadersModule.forRoot({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'https://cdn.example.com'],
          'connect-src': ["'self'", 'https://api.example.com'],
        },
        nonce: true,
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    }),
  ],
  controllers: [PagesController],
})
export class AppModule {}
```

This sends the default policy plus
`img-src 'self' https://cdn.example.com; connect-src 'self' https://api.example.com; script-src 'self' 'nonce-…'`.
Set `reportOnly: true` to send `Content-Security-Policy-Report-Only` instead.

## Nonces and route overrides

With `nonce` enabled, put `ctx.state.cspNonce` on your inline `<script>` tags. `@SecurityHeaders()`
changes the headers of one route or controller:

```ts
@Controller('/')
export class PagesController {
  @Get('/')
  home(ctx: Ctx) {
    const nonce = ctx.state.cspNonce ?? '';
    return new Response(
      `<!doctype html><title>Home</title><script nonce="${nonce}">console.log('hi')</script>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  // Embeddable on one partner site; every other header keeps the module's value.
  @Get('/widget')
  @SecurityHeaders({
    contentSecurityPolicy: {
      directives: { 'frame-ancestors': ['https://partner.example.com'] },
    },
    xFrameOptions: false,
  })
  widget() {
    return new Response('<!doctype html><title>Widget</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}
```

- Options you leave out keep the module's value, and `false` drops a header for that route.
- A method decorator replaces a controller decorator: the two are not merged with each other.
- The options are validated when the decorator is applied, so a bad override fails at import time.

## HSTS

| Option | Default | Description |
| --- | --- | --- |
| `maxAge` | `31536000` (one year) | Seconds. A non-negative integer; `0` tells browsers to forget the policy. |
| `includeSubDomains` | `true` | Appends `; includeSubDomains`. |
| `preload` | `false` | Appends `; preload`. Requires `includeSubDomains` and a `maxAge` of at least one year. |

- HSTS is sent only on secure requests (`ctx.secure`). Behind a TLS-terminating proxy, set
  `listen({ trustProxy })` to the proxy hop count or CIDRs, or HSTS is never sent. Do not trust
  more hops than there are proxies, or a client could claim `https` itself.
- A `maxAge` under 180 days (1 to 15551999 seconds) is allowed but logs one warning, because
  browsers then forget the policy quickly.

## Startup validation

`forRoot()`, `@SecurityHeaders()` and the middleware throw an `HttpConfigError` for:

- directive names that are not lowercase letters, digits and hyphens (`Script-Src` is rejected);
- directive sources containing `;`, `,`, a control character other than tab (CR, LF, NUL, ...) or
  a character above U+00FF, and array elements containing whitespace;
- an HSTS `maxAge` that is not a non-negative integer, and `preload` with
  `includeSubDomains: false` or a `maxAge` under one year, also after a route's
  `@SecurityHeaders()` is merged over the module options (the middleware checks every controller
  route's merge when it is created, so module `{ maxAge: 86_400 }` with a route
  `{ preload: true }` fails startup);
- any header-valued option (`referrerPolicy`, `xFrameOptions`, `permissionsPolicy` and the rest)
  that is neither `false` nor a string without control characters other than tab and without
  characters above U+00FF (Bun cannot send those in a header, so every response would fail).

The error names the header, so a line break cannot slip into a response:

```text
Invalid Referrer-Policy: "no-referrer\r\nX-Injected: 1"
```

## Documentation

- [`@knead-js/security-headers` reference](https://quinnjr.github.io/knead/packages/security-headers/):
  every option, the nonce rules and every export.
- [Security guide](https://quinnjr.github.io/knead/guide/security/): how security headers fit with
  CORS and rate limiting.
- [Server guide](https://quinnjr.github.io/knead/guide/server/): TLS and `trustProxy`.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
