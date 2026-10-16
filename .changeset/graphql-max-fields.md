---
"@knead/graphql": minor
---

New `maxFields` limit (default 1000, `FIELD_LIMIT`): field selections, with fragments expanded, are counted right after parsing, so oversized documents are rejected before the quadratic overlapping-fields validation and before Leaven caches them. `parseOptions.maxTokens` now defaults to 3000 (was 10000), and the document cache to `{ maxSize: 100 }`.

**New default limits.** Documents with more than 1000 fields or 3000 tokens are now rejected. Raise them with `GraphQLModule.forRoot({ maxFields: 5000, parseOptions: { maxTokens: 20000 } })` (or disable one with `Infinity`/`false`). Relay clients and persisted-query sets with large generated documents are the most likely to need higher values.
