# @hpmws/security-headers

`SecurityHeadersModule.forRoot()`: strict CSP (lowercase directive names, validated values, optional per-request nonces in `ctx.state.cspNonce`), HSTS on secure requests, `nosniff`, `Referrer-Policy`, COOP/CORP and `X-Frame-Options`, `Permissions-Policy` (default `camera=(), microphone=(), geolocation=(), interest-cohort=()`; `permissionsPolicy` overrides it, `false` drops it) and `X-Permitted-Cross-Domain-Policies: none` (`xPermittedCrossDomainPolicies`), with per-route `@SecurityHeaders()` overrides. The middleware registers at global priority 1100, outside CORS (1000) and rate limiting (900), so CORS preflights, 429s and errors raised by those layers carry the headers too.

HSTS options are validated at `forRoot()` and `@SecurityHeaders()`: `maxAge` must be a non-negative integer (seconds), and `preload` requires `includeSubDomains` and a `maxAge` of at least 31536000 (one year), as the preload list does. Anything else is an `HttpConfigError`. A `maxAge` between 1 and 15551999 (under 180 days, `MIN_RECOMMENDED_HSTS_MAX_AGE`) is allowed but logs one warning, since browsers then forget the policy quickly; `maxAge: 0` (which clears HSTS) does not.

HSTS is only sent on secure requests (`ctx.secure`). Behind a TLS-terminating proxy or load balancer the app sees plain HTTP, so configure `app.listen({ trustProxy })` (the hop count or the proxy CIDRs) to have `ctx.secure` follow the proxy's `X-Forwarded-Proto`; without it HSTS is never sent. Do not trust more hops than there are proxies, or a client could claim `https` itself.

`bun add @hpmws/core @hpmws/http @hpmws/security-headers` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
