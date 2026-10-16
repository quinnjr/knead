---
"@hpmws/graphql": patch
---

`RedisPubSub` encrypted envelopes carry an authenticated timestamp and are refused after `maxSignatureAge`, so encryption-only messages can no longer be replayed indefinitely. The docs give the safe key rotation order (`[old, new]` → `[new, old]` → `[new]`) and the remaining replay window.
