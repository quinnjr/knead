---
"@hpmws/graphql": minor
---

Security hardening:

- Safe default limits: `maxDepth` 10, `maxComplexity` 1000, `parseOptions.maxTokens` 10000, `maxQueryLength` 100 KiB (HTTP and WebSocket) and `maxAliases` 30; `Infinity` or `false` disables one. Exported as `GRAPHQL_LIMITS`.
- WebSocket: the same-origin check is `@hpmws/http`'s `originAllowed` (default ports normalized); a second `connection_init` closes with 4429; subscriptions that resolve after close or after `complete` are returned at once; a reused id returns the earlier iterator; `subscriptions.messageRate` and `subscriptions.maxConnectionLifetime` are passed to `WsRegistry`.
- Resolver guards pass only on `=== true`. New module-level `guards`, `defaultDeny` and `@Public()` (`ctx.meta[IS_PUBLIC]`).
- Revocation: `@Subscription({ recheckGuards: true })` and the injectable `GraphQLSubscriptions.closeWhere(predicate, code?, reason?)`.
- `onConnect` receives read-only `ConnectionParams` and returns `boolean | Partial<GraphQLContext>`; returning or spreading the params is a type error.
- Topics computed by a topic function may not contain `*` or `#` (BAD_USER_INPUT).
- GraphQL responses send `cache-control: no-store` (option `cacheControl`) and `x-content-type-options: nosniff`.
- `RedisPubSub`: `publish()` never rejects (new `publishOrThrow()`), a warning for plain `redis://` to a non-loopback host, and optional HMAC-SHA256 message signing (`signingKey`) over the prefixed channel, a timestamp and the payload, with `maxSignatureAge` (default 60s).
- Playground: `playground: { subscriptionEndpoint }`; otherwise the URL is derived only from a plain `host[:port]` Host header. Enabling it outside development logs a warning.
- Outside development, internal errors are logged as name, truncated message and a correlation id (also returned as `extensions.correlationId`), never as objects.
- Leaven packages are pinned to exactly `0.2.1`.
