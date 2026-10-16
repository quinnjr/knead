---
"@knead/http": minor
---

WebSocket endpoints accept only same-origin upgrades by default (same scheme via `ctx.secure`, same host, default ports normalized, `Origin: null` rejected, no Origin allowed); a disallowed origin is a 403 before guards run. `WsRegistry.register(path, endpoint, { allowedOrigins })` lists more origins or `'*'`. `originAllowed()` is exported.
