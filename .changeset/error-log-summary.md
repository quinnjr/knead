---
"@knead/http": minor
"@knead/graphql": patch
"@knead/rate-limit": patch
---

Framework error logging goes through one helper, `logError()` (exported, and injectable as `ErrorLog`): outside development it logs only the error's name and its message (redacted, then capped at 500 characters) under a correlation id, never the error object; in development the full error, redacted. The http pipeline, WebSocket registry, rate-limit store errors, GraphQL errors, subscriptions, Leaven's diagnostics and `RedisPubSub` use it, so redaction no longer depends on the configured logger. 5xx problem bodies carry the `correlationId`, and development 500 `detail`/`stack` are redacted. `RedisPubSub` logs topics JSON-quoted.
