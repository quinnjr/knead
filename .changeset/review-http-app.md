---
'@knead-js/http': patch
---

Harden the HTTP application and pipeline: both listeners run with Bun's development mode set to
the application's flag and answer errors that reach Bun with a masked `500` problem (never Bun's
HTML error page with the message and stack); the error handler always answers, dropping problem
extensions that do not serialize (such as a `BigInt`); `listen()` rejects invalid
`maxRequestBodySize`, `idleTimeout` and `shutdownTimeout` values and invalid middleware and
filter references with an `HttpConfigError`; only `GET` requests are treated as WebSocket
upgrades; `close()` awaits the redirect listener's stop and logs its failure; `ctx.headers` drops
`__proto__`, `constructor` and `prototype` keys.
