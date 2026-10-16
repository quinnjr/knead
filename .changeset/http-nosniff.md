---
"@hpmws/http": minor
---

Every response the framework builds (JSON, text, `Blob`, bytes, streams, `204`, problems and HTTPS redirects) now carries `x-content-type-options: nosniff`.
