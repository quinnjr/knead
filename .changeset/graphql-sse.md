---
'@knead-js/graphql': minor
'@knead-js/http': minor
'@knead-js/testing': minor
---

GraphQL over SSE. The GraphQL endpoint now also speaks the
[graphql-sse](https://github.com/enisdenjo/graphql-sse) protocol (distinct connections mode), on by
default: a `POST` or `GET` whose `Accept` prefers `text/event-stream` strictly over JSON gets an
event stream, with each subscription result as a `next` event and then `complete`, and a query or
mutation as one `next` and `complete`. Clients that send `*/*` or prefer JSON are unaffected.

- **Opting out.** `subscriptions.sse: false` keeps subscriptions on WebSocket only;
  `subscriptions: false` turns off both transports. `subscriptions.sse.keepAliveInterval` sets the
  keep-alive comment interval; by default it is half of `listen({ idleTimeout })`, at most the new
  `SSE_MAX_KEEP_ALIVE` (8000 ms, also the interval with `idleTimeout: 0`).
  An explicit interval above half a non-zero `idleTimeout` makes `listen()` throw
  `HttpConfigError`, and an `idleTimeout` of 1 to 4 s logs a warning, when the schema has a
  Subscription type.
- **The same checks as WebSocket.** Route middleware and guards, the `context` factory, root,
  `authorize` and field guards, `recheckGuards`, filters, per-event state, topic rules, masking,
  the origin check (before the body or the CSRF header is read) and the CSRF header on `GET` all
  apply. Streams carry `cacheControl` and `X-Content-Type-Options: nosniff`, as JSON responses do.
  The document is parsed, checked and validated once, by one executor call (the app's `onParse`
  first, the pre-execution hooks once per request), so a document that fails a limit or validation
  never takes a slot or runs `onConnect`. `onConnect` runs once per SSE
  subscription request with `params` `{}`: an `onConnect` that reads only `connectionParams`
  refuses SSE subscriptions with `403`, so authenticate SSE clients from headers or cookies.
- **Shared limits and revocation.** An open SSE subscription stream holds one of the
  `listen({ websocket })` connection slots shared with sockets (`429` per IP, `503` in total),
  taken before the `context` factory and `onConnect` run and returned only once they settle, even
  if the client aborts first; a request already aborted runs neither. A pending `onConnect` is
  bounded by `subscriptions.connectionInitTimeout` (default 3000 ms), past which the request
  answers `503` and a warning is logged (over WebSocket too), since the slot stays held until it
  settles. `GraphQLSubscriptions.closeWhere`, `maxConnectionLifetime` and shutdown end
  streams without `complete`; `closeWhere` counts the streams it ended. Both transports share one
  handshake and one deferred-revocation cap policy, so a stream ended at the
  `maxPendingRevocations` cap is counted as a socket closed there is (only when the predicate
  matches its empty context). A `subscription` on a schema without a Subscription type is refused
  as over JSON (`400` over `POST`, `405` over `GET`), without running `onConnect`. The rejection
  message for a subscription over JSON now names SSE when it is on. The context factory and
  `onConnect` failure logs name the transport (`... rejecting the WebSocket connection`).
- **WebSocket slot change.** A subscription socket that closes while its `context` factory or
  `onConnect` is pending now keeps its connection slot until they settle (it used to return it at
  once, so connect-and-close cycles could pile up pending `onConnect` calls past
  `maxConnectionsPerIp`), and `onConnect` is skipped when the socket closed during the factory.
- **WebSocket `onConnect` timeout (can close sockets in existing apps).** A subscription socket
  whose `onConnect` is still pending `subscriptions.connectionInitTimeout` (default 3000 ms) after
  `connection_init` is now closed with `4408` (Leaven's own timer stops at `connection_init`). An
  existing app whose `onConnect` takes longer than that must raise `connectionInitTimeout`.
- **`allowedOrigins` is validated at bootstrap whatever the schema.** SSE checks queries and
  mutations against `subscriptions.allowedOrigins`, so a value that is not `'*'` or an array of
  exact origins is an `HttpConfigError` from `GraphQLModule.forRoot()` even without a Subscription
  type. `ResolvedGraphQLOptions` gains `sse` (`false`, or `{ keepAliveInterval }`, undefined
  when the app set none) and the normalized `allowedOrigins`.
- **Request errors are JSON.** An operation rejected before any resolver ran is answered as JSON
  at `400` (`500` for `INTERNAL_SERVER_ERROR`); anything after execution started is streamed, so a
  retrying client never runs a mutation twice. `GraphQLRuntime.executor` is the newly exported
  `GraphQLExecutor` type, which gains `isRequestError(response)`.
- **Leaven upgrade.** `@leaven-graphql/core` 0.4.0, `@leaven-graphql/ws` 0.3.1 and the new
  `@leaven-graphql/sse` 0.4.0, pinned exactly.

`@knead-js/http`: `app.close()` ends open streaming responses that hold a connection slot before
it waits for in-flight requests. The new framework-internal `StreamRegistry` (provided by
`HttpCoreModule`, used by GraphQL SSE) holds those streams, sharing the WebSocket connection slots,
and checks stream keep-alives against the HTTP idle timeout; `WsRegistry` gains an internal slot
hold for pending connection work. The new
`normalizeAllowedOrigins(subject, origins)` validates and normalizes an `allowedOrigins` option as
`WsRegistry.register()` does, and `register()` now reports a non-array `allowedOrigins` by name.

`@knead-js/testing`: `TestApp.subscribeSse(query, options)` subscribes over graphql-sse and returns
the same iterator as `graphqlSubscribe()` (a response that is not `200` `text/event-stream`
rejects naming its status, content type and body); `readSse(res)` and `SseEvent` parse a raw
`text/event-stream` response.
