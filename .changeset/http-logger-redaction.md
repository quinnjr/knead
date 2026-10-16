---
"@knead-js/http": minor
---

`ConsoleLogger` masks URL credentials (`scheme://user:pass@` → `scheme://***@`) in messages, string arguments and Error messages, stacks and causes. `redactCredentials()` is exported.
