---
"@knead/http": minor
---

New `listen({ allowedHosts })` (DNS rebinding protection): a request whose Host is not listed gets `421 Misdirected Request` before middleware, routes, WebSocket upgrades and the Host-based HTTP→HTTPS redirect. The development default allows `localhost`, `127.0.0.1`, `[::1]` and the bound hostname; production has no check unless the option is set.
