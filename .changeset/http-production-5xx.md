---
"@knead/http": minor
---

Outside development, 5xx `HttpException` problem responses no longer include `detail` or extensions; only `type`, `title`, `status` and `instance` (plus the exception's headers) are sent.
