---
'@knead-js/core': minor
'@knead-js/schedule': patch
'@knead-js/rate-limit': patch
'@knead-js/cors': patch
---

Review fixes for scheduling, rate limiting and CORS.

- **core:** new `parseDuration(value, { label, error })`, `Duration`, `ParseDurationOptions` and
  `MAX_DURATION_MS`, the duration parser `@knead-js/schedule` and `@knead-js/rate-limit` now share
  (their own `parseDuration` exports are unchanged).
- **schedule:** a cron job armed during the second occurrence of a repeated (fall-back) hour now
  skips the rest of that hour, as an instance running through it does, so a `lock: true` job can
  no longer run twice across replicas. An `AbortSignal` listener on a job's `signal` can no longer
  add, resume or arm a job while the scheduler shuts down.
- **rate-limit:** a store outage logs the first failure, then at most one line every 10 seconds
  with the count of failures not logged, then one line on recovery, instead of one warning per
  request. A `RateLimitGuard` check without `@RateLimit()` counts once per HTTP request, so a
  guarded nested GraphQL field no longer consumes one token per resolved item.
- **cors:** a string origin that can never equal a browser's `Origin` header (a trailing slash,
  uppercase, a path, a default port) is a `CorsConfigError` naming the canonical form, and a
  non-boolean `credentials` is rejected.
