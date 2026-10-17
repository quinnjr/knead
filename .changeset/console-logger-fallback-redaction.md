---
'@knead-js/core': patch
---

`ConsoleLogger` redacts credentials in its fallback output too. When formatting a log call failed (for example a non-string message from untyped code), the message was printed escaped but not redacted, so a URL password in it reached the console. A message that cannot be stringified is now printed as `[unloggable message]`.

In development, `logError()` passes an error that needed redacting to the logger as an `Error` (its message redacted and its stack the redacted stack, causes and properties) instead of a string, so loggers format every error the same way: `JsonLogger` writes it under `err` like any other error rather than as a `meta` string.
