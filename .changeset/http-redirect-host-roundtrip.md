---
"@knead/http": patch
---

`redirectHttp.host` must round-trip through the URL parser: values such as `1.2.3.256`, `[1.2.3.4]`, `xn--a`, `0x7f.1` or `:99999`, which the URL setters silently rejected (so the Location fell back to the request's Host), are now a configuration error at `listen()`. The canonical origin is computed once and the Location is built as origin + path + query.
