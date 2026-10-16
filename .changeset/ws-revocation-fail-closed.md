---
"@hpmws/http": patch
"@hpmws/graphql": patch
---

`closeWhere` predicates kept for upgrading sockets are applied before the endpoint's `open` runs, and fail closed: when one newer than the socket's upgrade was already evicted or expired (or the upgrade took over 30s), the socket is closed with 1008 "Revocation state unavailable". Upgrades that never open no longer keep the in-progress count up (30s TTL). GraphQL sockets revoked before they opened are checked again once their init completes.
