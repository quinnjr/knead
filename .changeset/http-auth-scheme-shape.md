---
"@knead-js/http": patch
---

`Bearer`/`Basic` redaction applies only to credential-shaped values (8+ token characters, or containing `:`/`=`), so prose such as "Invalid basic auth header; a basic mistake" stays readable.
