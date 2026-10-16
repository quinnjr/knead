---
"@hpmws/http": minor
"@hpmws/graphql": minor
---

New opt-in `authorize` guards on HTTP routes and GraphQL resolvers, run after validation so they see the validated, transformed input (`ctx.body`/`ctx.query`/... or `ctx.args`). Ordinary guards still run before validation; the READMEs document the order.
