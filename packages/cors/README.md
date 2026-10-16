# @hpmws/cors

`CorsModule.forRoot({ origin, credentials, … })`: global CORS middleware that answers preflight requests before routing and rejects unsafe configurations at startup (`origin: '*'` with credentials, or `'*'` inside an origin list).

Browsers do not apply CORS to WebSockets, so the middleware also guards upgrades: a WebSocket upgrade request (`Upgrade: websocket`) whose `Origin` is not allowed is rejected with 403 before the endpoint's `upgrade()` runs. Upgrades without an `Origin` header (non-browser clients) are let through. `WsRegistry` separately accepts only same-origin upgrades unless the endpoint lists more in `allowedOrigins`, so list your cross-origin front-ends there too (`ws.register(path, endpoint, { allowedOrigins: ['https://app.example'] })`).

An `Origin` header longer than 2048 characters is treated as disallowed without consulting the configured rule. A RegExp `origin` must be anchored and linear: write `/^https:\/\/([a-z0-9-]+\.)?app\.example$/`, not `/app\.example/` (which also matches `https://app.example.evil.com`), and avoid nested quantifiers such as `(a+)+`, which can backtrack catastrophically on a crafted Origin.

`bun add @hpmws/core @hpmws/http @hpmws/cors` (`@hpmws/core` and `@hpmws/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
