---
"@knead-js/http": minor
---

A WebSocket upgrade on the path of a `GET` route now also runs that route's module, controller and route middleware and its controller and route guards (after the global ones), with `ctx.route`/`ctx.meta` set to the route. Previously a controller guard such as an admin check did not protect a WebSocket endpoint sharing its path. Endpoints without a `GET` route are unchanged.
