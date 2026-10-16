---
"@knead/http": minor
---

After a `body` schema validates, `ctx.json()` resolves to the validated value. Validation issues from the `headers` source use the generic message `Invalid header value` (the path is kept).
