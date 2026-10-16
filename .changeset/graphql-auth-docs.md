---
"@knead/graphql": patch
---

Docs: `@Public()` is GraphQL-only (HTTP global guards still apply), and `defaultDeny` protects entry points only, so sensitive `@ResolveField`/`@Field` data needs its own guards.
