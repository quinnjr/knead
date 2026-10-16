---
"@knead-js/http": minor
---

Log redaction covers more: credential URLs nested inside http(s) URLs, `password=`/`pwd=`/`secret=`/`token=`/`apikey=`-style pairs, `Bearer`/`Basic` credentials, and (through the new exported `redactValue()`) plain objects, arrays and Error own properties walked 4 levels deep, with sensitive keys such as `authorization` and `cookie` replaced by `***`. `ConsoleLogger` escapes control characters in messages and string meta, and the new `logValue()` caps and escapes client values interpolated into log messages. `MemoryLogger` is documented as tests-only (it keeps entries unredacted).
