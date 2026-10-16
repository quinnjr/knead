---
"@hpmws/http": minor
---

Revocations kept for upgrading sockets no longer fail legitimate upgrades closed after unrelated `closeWhere()` bursts: the list holds `websocket.maxPendingRevocations` (new, default 10000) predicates, a predicate leaving it is first checked against every upgrade that already has its socket data, and only an upgrade that could not be checked (still in its guards, or no longer pending) fails closed. A slow upgrade alone no longer fails closed. Expired upgrades are swept in amortized batches, so 20k upgrades plus `closeWhere()` calls take milliseconds instead of seconds.
