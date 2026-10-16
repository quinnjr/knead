---
"@knead-js/graphql": minor
---

`RedisPubSub` `signingKey` accepts an array for rotation (sign with the first key, verify with any), copies `Uint8Array` keys at construction, and `maxSignatureAge` must be between 1 ms and 10 minutes.
