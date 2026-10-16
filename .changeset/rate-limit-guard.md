---
"@knead-js/rate-limit": minor
---

New `RateLimitGuard` (usable with `@UseGuards()` or as `APP_GUARD`) applies the module's limits and `@RateLimit()` overrides in the guard phase, so key functions can read `ctx.state` set by earlier guards (per-user limits). `forRoot({ middleware: false })` disables the global middleware. The shared check is exported as `RateLimiter`.
