---
"@knead-js/http": minor
---

`maxConnectionsPerIp` groups IPv6 clients by /64 (new `listen({ websocket: { ipv6Subnet } })`, default 64). `maskIp(ip, prefix)` moved from `@knead-js/rate-limit` into `@knead-js/http` (rate-limit re-exports it).
