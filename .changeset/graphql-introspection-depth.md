---
"@hpmws/graphql": minor
---

New `maxIntrospectionDepth` (default 15, the depth of `getIntrospectionQuery()`): selections under `__schema`/`__type`, which `maxDepth` does not count, are capped separately, so introspection bombs are `DEPTH_LIMIT`.
