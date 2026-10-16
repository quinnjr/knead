---
"@hpmws/graphql": patch
---

Revocations deferred until a subscription socket's init completes are capped at 100 per socket; past that the socket is closed with 1008 (fail closed).
