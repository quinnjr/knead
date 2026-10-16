---
"@knead-js/graphql": patch
---

A WebSocket `subscribe` or `complete` message whose id does not match `^[A-Za-z0-9_.:-]{1,64}$` closes the socket with 4400 before it reaches Leaven (ids end up in logs).
