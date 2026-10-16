---
"@knead-js/http": patch
---

The `Bearer`/`Basic` `:`/`=` branch needs a token character right before and after the separator, so "basic setup: done" stays readable while `Basic user:pass` is still redacted. Short tokens such as `Bearer abc123` stay unredacted (documented known limit).
