---
"@knead/http": minor
---

Guards pass only when they return exactly `true` (truthy values such as `1` or `'yes'` are now a 403). `ctx.meta` aliases `ctx.route?.meta`, or an empty frozen object without a route, so role guards read the same `ctx.meta` on routes and GraphQL resolvers.
