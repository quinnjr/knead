---
"@knead-js/http": minor
---

`redirectHttp.host` sets a canonical host for the HTTP→HTTPS redirect (the request's Host header is then ignored), and the 308 is sent with `cache-control: no-store`.
