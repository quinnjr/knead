---
'@knead-js/rate-limit': patch
'@knead-js/cors': patch
'@knead-js/security-headers': patch
'@knead-js/schedule': patch
---

Middleware audit fixes. `RateLimitGuard` on a GraphQL resolver now calls every key function (the module `key` and a `@RateLimit({ key })`) with the HTTP `Ctx` (`ctx.http`), as `KeyFn` is typed and as the documentation says; before, only the default key did, so a custom key that read `ctx.req` threw and one that read `ctx.ip` or `ctx.state` collapsed every caller into one bucket. This changes behaviour if a key function relied on receiving the `ResolverCtx`: read the request from the `Ctx` it is given, and store what it reads on `ctx.http.state`. `validateCorsOptions()` (and so `CorsModule.forRoot()`) now throws a `CorsConfigError` for `methods`, `allowedHeaders` or `exposedHeaders` that are not arrays of HTTP tokens, instead of a `TypeError` at construction or a 500 on every request. `SecurityHeadersMiddleware` validates each controller route's `@SecurityHeaders()` override merged over the module options when it is created, so a route `preload` over a module `maxAge` under one year (or a route `includeSubDomains: false` under a module `preload`) fails startup instead of sending an invalid HSTS header. Jobs on a `multi: true` class provider are now a `ScheduleConfigError` at bootstrap instead of being skipped silently.
