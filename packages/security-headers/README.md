# @hpmws/security-headers

`SecurityHeadersModule.forRoot()`: strict CSP (lowercase directive names, validated values, optional per-request nonces in `ctx.state.cspNonce`), HSTS on secure requests, `nosniff`, `Referrer-Policy`, COOP/CORP and `X-Frame-Options`, with per-route `@SecurityHeaders()` overrides.

`bun add @hpmws/core @hpmws/http @hpmws/security-headers` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
