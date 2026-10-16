---
"@knead/graphql": minor
---

New `maxIntrospectionDepth` (default 20, headroom above the depth 15 of `getIntrospectionQuery()`): selections under `__schema`/`__type`, which `maxDepth` does not count, are capped separately, so introspection bombs are `DEPTH_LIMIT`.
