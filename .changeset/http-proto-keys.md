---
"@hpmws/http": patch
---

Parsed query strings and forms drop `__proto__`, `constructor` and `prototype` keys, and JSON bodies drop `__proto__` (and `constructor`/`prototype` holding objects) at every depth, so merging a body into an object cannot change its prototype.
