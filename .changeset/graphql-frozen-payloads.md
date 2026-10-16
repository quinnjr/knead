---
"@hpmws/graphql": minor
---

Subscription event payloads are deep-frozen when they arrive (in-memory `PubSub` and `RedisPubSub`), so one subscriber's resolver cannot change what the others receive. `deepFreeze` is exported.
