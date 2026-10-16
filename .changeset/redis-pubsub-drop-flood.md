---
"@knead/graphql": minor
---

`RedisPubSub` reports dropped messages at most once per 10s per instance (with a count), and rejects messages over the new `maxMessageBytes` (default 1 MiB) before any HMAC, decryption or JSON work.
