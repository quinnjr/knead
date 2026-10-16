---
"@hpmws/http": patch
"@hpmws/testing": patch
---

Docs: the TLS floor is Bun's (BoringSSL) default, and `TestRequestInit.tls.rejectUnauthorized: false` is for tests only.
