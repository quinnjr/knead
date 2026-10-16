---
"@hpmws/http": minor
"@hpmws/graphql": patch
---

New `listen({ validation: { redactIssueMessages: true } })` replaces body and query validation issue messages with `Invalid value` (paths kept), so schemas that quote input never echo it. The GraphQL README notes that graphql-js coercion errors quote values.
