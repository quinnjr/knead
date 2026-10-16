---
"@hpmws/http": patch
---

`redactCredentials` (and so `ConsoleLogger`) masks the whole URL userinfo, up to the last `@` before the host, so passwords containing `@` or `/` (`redis://u:p@ss@h`, `redis://u:a/b@h`) no longer leak.
