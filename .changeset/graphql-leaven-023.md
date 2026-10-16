---
"@hpmws/graphql": patch
---

Upgrade Leaven core and ws to 0.2.3: subscription ids are validated (`^[A-Za-z0-9_.:-]{1,64}$`, otherwise close 4400), client-controlled values are escaped in Leaven's log and error text, documents and compiled queries are cached only after validation, depth and complexity pass, and both caches are bounded by bytes.
