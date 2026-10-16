---
"@knead-js/graphql": patch
---

Upgrade Leaven to 0.2.2: the playground loads `graphql-playground-react` 1.7.28 (fixes CVE-2021-41249) with re-pinned integrity hashes, Leaven's caches no longer key on a collidable 64-bit hash, and its WebSocket handler, subscription manager and the default in-memory `PubSub` now log through `LOGGER`.
