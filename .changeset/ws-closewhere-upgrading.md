---
"@hpmws/http": patch
---

`WsRegistry.closeWhere()` no longer misses sockets that are still upgrading: predicates issued while an upgrade is in progress (in guards, or between `server.upgrade()` and `open`) are kept for up to 30s (at most 100) and applied to those sockets when they open.
