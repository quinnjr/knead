# @hpmws/cors

`CorsModule.forRoot({ origin, credentials, … })`: global CORS middleware that answers preflight requests before routing and rejects unsafe configurations at startup (`origin: '*'` with credentials, or `'*'` inside an origin list).

Browsers do not apply CORS to WebSockets, so the middleware also guards upgrades: a WebSocket upgrade request (`Upgrade: websocket`) whose `Origin` is not allowed is rejected with 403 before the endpoint's `upgrade()` runs. Upgrades without an `Origin` header (non-browser clients) are let through.

`bun add @hpmws/cors`. Licensed MIT OR Apache-2.0.
