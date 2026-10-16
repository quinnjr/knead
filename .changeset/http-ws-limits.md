---
"@hpmws/http": minor
---

WebSocket limits with safe defaults through `listen({ websocket })`: `maxPayloadLength` 256 KiB, `backpressureLimit` 1 MiB with `closeOnBackpressureLimit`, `idleTimeout` 120s, `maxConnectionsPerIp` 100 (429 above it), optional `maxConnections` (503), and a per-socket `messageRate` token bucket (100 messages per 10s; closes with 1008). Endpoints can override `messageRate` and set `maxConnectionLifetime` (closes with 4408). `WsRegistry.closeWhere(predicate, code?, reason?)` closes matching sockets.
