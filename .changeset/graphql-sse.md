---
'@knead-js/graphql': minor
'@knead-js/http': patch
'@knead-js/testing': minor
---

GraphQL over SSE. The GraphQL endpoint now also speaks the
[graphql-sse](https://github.com/enisdenjo/graphql-sse) protocol (distinct connections mode), on by
default: a `POST` or `GET` whose `Accept` prefers `text/event-stream` strictly over JSON gets an
event stream, with each subscription result as a `next` event and then `complete`, and a query or
mutation as one `next` and `complete`. Clients that send `*/*` or prefer JSON are unaffected.

- **Opting out.** `subscriptions.sse: false` keeps subscriptions on WebSocket only;
  `subscriptions: false` turns off both transports. `subscriptions.sse.keepAliveInterval` sets the
  keep-alive comment interval; by default it is half of `listen({ idleTimeout })`, at most 8000 ms.
  An explicit interval above half a non-zero `idleTimeout` makes `listen()` throw
  `HttpConfigError`, and an `idleTimeout` of 1 to 4 s logs a warning, when the schema has a
  Subscription type.
- **The same checks as WebSocket.** Route middleware and guards, the `context` factory, root,
  `authorize` and field guards, `recheckGuards`, filters, per-event state, topic rules, masking,
  the origin check and the CSRF header on `GET` all apply. `onConnect` runs once per SSE
  subscription request with `params` `{}`: an `onConnect` that reads only `connectionParams`
  refuses SSE subscriptions with `403`, so authenticate SSE clients from headers or cookies.
- **Shared limits and revocation.** An open SSE subscription stream holds one of the
  `listen({ websocket })` connection slots shared with sockets (`429` per IP, `503` in total), and
  `GraphQLSubscriptions.closeWhere`, `maxConnectionLifetime` and shutdown end streams without
  `complete`; `closeWhere` counts the streams it ended.
- **Request errors are JSON.** An operation rejected before any resolver ran is answered as JSON
  at `400` (`500` for `INTERNAL_SERVER_ERROR`); anything after execution started is streamed, so a
  retrying client never runs a mutation twice. `GraphQLRuntime.executor` gains
  `isRequestError(response)`.
- **Leaven upgrade.** `@leaven-graphql/core` 0.4.0, `@leaven-graphql/ws` 0.3.1 and the new
  `@leaven-graphql/sse` 0.4.0, pinned exactly.

`@knead-js/http`: `app.close()` ends open streaming responses that hold a connection slot before
it waits for in-flight requests, and `WsRegistry` gains internal stream slots and a keep-alive
check against the HTTP idle timeout.

`@knead-js/testing`: `TestApp.subscribeSse(query, options)` subscribes over graphql-sse and returns
the same iterator as `graphqlSubscribe()`; `readSse(res)` and `SseEvent` parse a raw
`text/event-stream` response.
