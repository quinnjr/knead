---
'@knead-js/core': patch
'@knead-js/http': patch
'@knead-js/graphql': patch
'@knead-js/config': patch
'@knead-js/logging': patch
'@knead-js/cors': patch
'@knead-js/rate-limit': patch
'@knead-js/security-headers': patch
'@knead-js/sanitize': patch
'@knead-js/schedule': patch
'@knead-js/prisma': patch
'@knead-js/casl': patch
'@knead-js/testing': patch
---

Fix conformance gaps found by a project-wide audit:

- `redactValue` no longer returns a `Headers`, `Map` or other entries-like object unredacted at the depth limit or inside a cycle, and now redacts non-`Error` causes and `AggregateError.errors` deeper in a cause chain.
- `JsonLogger` in development no longer hangs on an error that contains itself, and nested errors share the depth limit (at most 100 detailed errors per record).
- Transients resolved after startup are no longer tracked for lifecycle hooks (an unbounded leak).
- WebSocket endpoints are reachable behind a covering `/:param` or wildcard GET route; an explicit `undefined` no longer overrides WebSocket defaults; upgrade slots of sockets that never open are released.
- CORS origin predicates, GraphQL `refreshContext` and revocation checks fail closed on non-`true`/non-object results.
- More options are validated at startup instead of failing per request: route `status`, `defaultCacheControl`, security-header and CSP values Bun cannot send, CORS `origin`, rate-limit `store`/`key`/`middleware`, `sweepIntervalMs`, GraphQL `cacheControl`/CSRF headers/timeouts, sanitize preset names, `PrismaModule.forRootAsync` and `TransactionHost.run` `isolationLevel`.
- The rate-limit Redis store's own client no longer queues commands while Redis is unreachable; the scheduler logs through the application `LOGGER`; cron jobs no longer re-fire during a DST fall-back hour; cron patterns are capped at 1024 characters.
- Per-request work is cached (CORS and security headers, playground pages, interface resolution, route 405 lookup), and packages gain npm keywords, homepages and Bun-oriented descriptions.
