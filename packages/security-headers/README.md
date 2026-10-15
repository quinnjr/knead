# @hpmws/security-headers

`SecurityHeadersModule.forRoot()`: strict CSP (lowercase directive names, validated values, optional per-request nonces in `ctx.state.cspNonce`), HSTS on secure requests, `nosniff`, `Referrer-Policy`, COOP/CORP and `X-Frame-Options`, with per-route `@SecurityHeaders()` overrides.

`bun add @hpmws/security-headers`. Licensed MIT OR Apache-2.0.
