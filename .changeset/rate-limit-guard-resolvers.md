---
"@knead-js/rate-limit": patch
---

`RateLimitGuard` works on GraphQL resolvers: it reads the IP from `ctx.http`, sets the `RateLimit-*` headers on `ctx.http.res`, uses the resolver's `@RateLimit()` metadata with one counter per field, and no longer assumes `ctx.res` exists.
