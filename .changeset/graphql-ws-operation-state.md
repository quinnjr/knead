---
"@knead-js/graphql": patch
---

Every GraphQL operation over a WebSocket gets its own view of the upgrade `ctx.http` with a fresh `state`, so `ctx.http.state` written in one operation is not visible in the next.
