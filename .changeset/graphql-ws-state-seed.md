---
"@knead/graphql": patch
---

Each WebSocket operation's `ctx.http.state` starts as a shallow copy of the upgrade request's state, so values set by middleware and guards at upgrade time (`context: (http) => ({ user: http.state.user })`) are visible again, while operations still never see each other's writes.
