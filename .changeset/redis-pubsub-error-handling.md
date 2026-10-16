---
"@knead/graphql": patch
"@knead/http": patch
---

`RedisPubSub` isolates throwing `onError` callbacks (logged; the other listeners are still told), and a failing queued SUBSCRIBE/UNSUBSCRIBE no longer stalls its topic's queue. A listener whose graceful stop rejects during `close()` is logged instead of leaving an unhandled rejection.
