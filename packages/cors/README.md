# @knead/cors

`CorsModule.forRoot({ origin, credentials, … })`: global CORS middleware that answers preflight requests before routing and rejects unsafe configurations at startup (`origin: '*'` with credentials, or `'*'` inside an origin list).

Browsers do not apply CORS to WebSockets, so the middleware also guards upgrades: a WebSocket upgrade request (`Upgrade: websocket`) whose `Origin` is not allowed is rejected with 403 before the endpoint's `upgrade()` runs. Upgrades without an `Origin` header (non-browser clients) are let through. `WsRegistry` separately accepts only same-origin upgrades unless the endpoint lists more in `allowedOrigins`, so list your cross-origin front-ends there too (`ws.register(path, endpoint, { allowedOrigins: ['https://app.example'] })`).

An `Origin` header longer than 2048 characters is treated as disallowed without consulting the configured rule. A RegExp `origin` must be anchored and linear: write `/^https:\/\/([a-z0-9-]+\.)?app\.example$/`, not `/app\.example/` (which also matches `https://app.example.evil.com`). The anchoring is enforced: at `forRoot()`, a RegExp whose source does not start with `^` and end with `$` is a `CorsConfigError` naming the pattern ; a top-level `|` (outside groups and character classes, unescaped) is rejected too, because `^a|b$` anchors each side only once: group the alternatives inside the anchors, `/^(?:https:\/\/a\.example|https:\/\/b\.example)$/`. Also avoid nested quantifiers such as `(a+)+`, which can backtrack catastrophically on a crafted Origin.

`bun add @knead/core @knead/http @knead/cors` (`@knead/core` and `@knead/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
