# @knead-js/testing

`Test.createModule()` with provider, guard, middleware and filter overrides, plus `createApp()` for requests against a real ephemeral Bun server. `app.request(..., { tls: { rejectUnauthorized: false } })` accepts self-signed test certificates; it is for tests only.

`bun add @knead-js/core @knead-js/http` and `bun add -d @knead-js/testing` (`@knead-js/core` and `@knead-js/http` are peer dependencies, so every package shares one copy). Licensed MIT OR Apache-2.0.
