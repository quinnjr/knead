---
"@knead/http": minor
---

`listen()` caps request bodies at 1 MiB by default (`maxRequestBodySize`); larger bodies are answered with 413.
