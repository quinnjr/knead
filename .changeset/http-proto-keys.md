---
"@hpmws/http": patch
---

Parsed query strings and forms drop `__proto__`, `constructor` and `prototype` keys, and JSON bodies drop `__proto__` (and `constructor`/`prototype` holding objects) at every depth, so merging a body into an object cannot change its prototype.

**Behaviour change:** legitimate `constructor` or `prototype` keys are dropped too (in JSON when they hold an object; in query strings and forms always), so an API that uses those field names must rename them.
