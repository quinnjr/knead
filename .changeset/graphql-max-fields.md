---
"@hpmws/graphql": minor
---

New `maxFields` limit (default 1000, `FIELD_LIMIT`): field selections, with fragments expanded, are counted right after parsing, so oversized documents are rejected before the quadratic overlapping-fields validation and before Leaven caches them. `parseOptions.maxTokens` now defaults to 3000, and the document cache to `{ maxSize: 100 }`.
