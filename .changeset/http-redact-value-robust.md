---
"@knead-js/http": patch
---

`redactValue` survives throwing getters (`[unreadable]`) and hostile Proxies (a summary), and walks `Headers`, `Map` and header-like objects (`entries()`/`toJSON()`, e.g. AxiosHeaders) so `err.config.headers.Authorization` is redacted. `ConsoleLogger` and `logError` never throw into the caller, so a logging failure cannot turn into Bun's development error page.
