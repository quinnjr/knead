---
"@knead-js/http": patch
"@knead-js/testing": patch
---

Docs: the TLS floor is Bun's (BoringSSL) default, and `TestRequestInit.tls.rejectUnauthorized: false` is for tests only.
