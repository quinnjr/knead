---
"@knead-js/http": patch
---

Without `redirectHttp.host`, the HTTP→HTTPS redirect validates the request's Host with the same strict, round-tripping `host[:port]` check and answers 400 when it fails; `listen()` warns that `host` is unset.
