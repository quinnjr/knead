---
'@knead-js/graphql': patch
---

Fix GraphQL subscription and engine findings from the v0.4.0 conformance audit:

- Each subscription event now resets `ctx.state` and its DataLoaders before its `filter` and its
  `recheckGuards` recheck run, not only before its resolver. A rechecked guard that memoises roles in
  `ctx.state` or loads them through `ctx.loader()` no longer passes on what subscribe time or the
  previous event cached, and the event's resolvers see what its filter and recheck set.
- A throwing subscription `filter` is delivered in place of the event through the error formatter,
  so a client `HttpException` (or one returned by `mapError`) keeps its `extensions.code`;
  unexpected errors are still logged and masked. The subscription then ends, as before.
- `RedisPubSub` no longer subscribes a channel for a listener set that was ended (connection lost,
  or its last listener left) while its SUBSCRIBE was queued, which leaked the channel and delivered
  every later message twice.
- `RedisPubSub` rejects a `publishTimeout` above `2 ** 31 - 1` with an `HttpConfigError`.
- `@Resolver(() => T)` builds `T` even when the resolver has no `@ResolveField()` methods.
- A `PubSub` built by hand and passed as `pubsub` logs through `LOGGER` (redacted) instead of
  `console`, unless it was given its own `logger`.
- The WebSocket handler no longer parses ping and pong frames twice.
