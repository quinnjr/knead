---
'@knead-js/http': minor
---

**Breaking:** a `WsEndpoint.upgrade()` that returns `undefined` (or nothing) now rejects the upgrade
with `403 WebSocket upgrade rejected`, like `false` (fail closed). Return `null` or `{}` to accept a
socket without data.

Fixes from the whole-project audit:

- `listen({ port })` and `redirectHttp.port` must be integers from 0 to 65535, and
  `shutdownTimeout` at most `2 ** 31 - 1`; anything else is an `HttpConfigError` at `listen()`,
  before anything binds (a larger `shutdownTimeout` made close() stop waiting after about 1 ms).
- A `trustProxy` that is not `false`, a hop count or an array (such as `true` or a single CIDR
  string), and an `allowedHosts` that is not an array or `false` (such as a single string), are an
  `HttpConfigError` at `listen()` instead of a bare `TypeError` or a check on each character.
- `defaultCacheControl` now also applies to the `redirectHttp` listener's `421` and to the masked
  `500` of an error that reaches Bun.
- A WebSocket endpoint's `allowedOrigins` is copied at `register()`, so changing the array later
  cannot widen the origin check; the check is a set lookup instead of parsing every entry on each
  upgrade. `originAllowed()` also accepts a `ReadonlySet` of normalized origins.
- An upgrade's merged `ctx.meta` is computed once at `listen()`, `ctx.ip` and `ctx.secure` share one
  socket address lookup and one `X-Forwarded-For` parse, and `defaultCacheControl` is set in place
  instead of copying the response headers.
