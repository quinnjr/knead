---
"@hpmws/graphql": patch
---

`deepFreeze` (and so subscription payload freezing) freezes only plain objects and arrays, and leaves publisher-owned class instances, Dates, Maps, Buffers and ORM graphs unfrozen.
