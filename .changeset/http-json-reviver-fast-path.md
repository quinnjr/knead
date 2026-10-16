---
"@knead/http": patch
---

JSON bodies use the key-dropping reviver only when the text contains `__proto__`, `constructor`, `prototype` or a `\u` escape, so ordinary bodies parse at native speed again (the reviver made every body about 7x slower). Documented that `constructor`/`prototype` keys holding objects are dropped.
