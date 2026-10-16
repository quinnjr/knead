---
"@knead-js/http": patch
---

A `closeWhere` predicate evaluated at eviction time gets a stand-in socket with only `data`; if it reads any other property the upgrade counts as not evaluated and fails closed at open. Documented that predicates should read only `ws.data`.
