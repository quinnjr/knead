---
"@hpmws/graphql": patch
"@hpmws/http": patch
---

The per-socket cap on revocations deferred until a GraphQL socket's init completes is the registry's `websocket.maxPendingRevocations` (default 10000, exposed as `WsRegistry.maxPendingRevocations`) instead of a fixed 100; overflow still fails closed with 1008.
