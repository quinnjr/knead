---
"@knead-js/http": patch
---

A Host rejected with 421 by `allowedHosts` is logged once per distinct host, with a hint to add it to `listen({ allowedHosts })`.
