---
'@knead-js/graphql': patch
---

GraphQL transport fixes from the code review:

- `RedisPubSub` no longer goes silent when its subscriber connection dies: when it closes, or Bun
  reconnects it without its channel subscriptions, every subscription ends through `onError` and
  the next `subscribe()` opens a new connection. An owned publisher that Bun gave up on (or closed
  on `idleTimeout`) is reconnected on its next use.
- `subscriptions.maxConnectionLifetime` must be an integer from 1 to 2147483647 (`HttpConfigError`);
  larger values made the timer fire after about 1 ms and close every socket.
- The subscription endpoint answers with `Sec-WebSocket-Protocol: graphql-transport-ws` even when
  the client offers it after another subprotocol.
- A `context` factory that throws at `connection_init` now rejects the connection (`4403`, logged)
  instead of accepting it without an identity.
- An over-long `subscribe` reusing an active id closes the socket with `4409`, like any other.
- The in-memory `PubSub` deep-freezes payloads in `publish()`, whether or not anything is
  subscribed, and `eventIterator()` undoes earlier topics when subscribing to a later one throws.
