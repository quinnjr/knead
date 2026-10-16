---
"@knead/http": patch
---

Multipart bodies are buffered (within `maxRequestBodySize`) and their boundary delimiters counted before the multipart parser runs: more than `maxParams` parts is a 413 without parsing any of them.
