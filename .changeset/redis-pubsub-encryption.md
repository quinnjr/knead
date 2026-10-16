---
"@knead-js/graphql": minor
---

`RedisPubSub` gets optional payload encryption: `encryptionKey` (one key or an array for rotation, at least 32 bytes) encrypts each payload with AES-256-GCM, a random 12-byte IV and the channel as AAD. It combines with `signingKey` (encrypt, then sign the envelope); messages that fail to decrypt are dropped and logged.
