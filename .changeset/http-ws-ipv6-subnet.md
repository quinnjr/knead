---
"@hpmws/http": minor
---

`maxConnectionsPerIp` groups IPv6 clients by /64 (new `listen({ websocket: { ipv6Subnet } })`, default 64). `maskIp(ip, prefix)` moved from `@hpmws/rate-limit` into `@hpmws/http` (rate-limit re-exports it).
