---
"@knead-js/http": minor
---

Global guards (`APP_GUARD` and `useGlobalGuards()`) now also run on WebSocket upgrade requests, with `ctx.route` set to `null`. A guard that returns `false` answers the upgrade with 403.
