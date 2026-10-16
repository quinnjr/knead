---
"@hpmws/http": patch
---

The JSON key-filtering pass runs only for a literal `__proto__`/`constructor`/`prototype` or a `\u00XX` escape of a printable ASCII character, so `ensure_ascii` payloads with non-ASCII text stay on the native fast path. Legitimate `constructor`/`prototype` keys holding objects are still dropped (documented).
