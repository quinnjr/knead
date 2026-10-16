---
"@hpmws/http": patch
---

A WebSocket upgrade on a GET route's path also runs that route's `authorize` guards, after its `guards`. Upgrades are not validated, so `authorize` sees the raw request there.
