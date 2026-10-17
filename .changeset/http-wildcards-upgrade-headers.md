---
'@knead-js/http': patch
---

A route path whose `*` is not the whole last segment (`/a/*/b`, `/a*`) is a configuration error at `listen()`. Bun's router never matched such routes, so requests to them got a 405 from the fallback.

Headers set on `ctx.res.headers` before a WebSocket upgrade (by middleware before `next()`, guards or the endpoint's `upgrade()`) are sent with the `101` handshake instead of being dropped. Headers that middleware adds to the returned response after `next()` still cannot reach the handshake, which Bun has already written.
