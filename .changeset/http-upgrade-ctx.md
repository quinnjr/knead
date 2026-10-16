---
"@knead/http": minor
---

`Ctx.upgrade` is `{ path }` on WebSocket upgrade requests and `null` otherwise, so global middleware and guards can tell upgrades apart.
