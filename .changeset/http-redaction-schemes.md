---
"@hpmws/http": patch
---

`redactCredentials` exempts `host[:port]/path@…` only for `http:` and `https:` URLs, so `redis://admin:2024/pw@host` is masked. Passwords with spaces or quotes cannot appear unencoded in a valid URL and are not recognized.
