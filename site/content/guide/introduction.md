---
title: Introduction
description: What Knead is, the ideas it is built on, and how its packages fit together.
---

Knead is a web framework for [Bun](https://bun.sh) in the style of NestJS. You organize an
application into **modules**. Modules declare **providers** (services, repositories, anything
injectable) and **controllers** (classes whose decorated methods handle HTTP routes). Knead wires
them together with dependency injection, runs a request pipeline of middleware, guards and
exception filters around each handler, and serves it all from Bun's native HTTP server.

<<< home/hello.ts title="main.ts"

## Design principles

### Standard decorators

Knead uses the TC39 decorators that TypeScript 5+ and Bun implement natively. It does not use
`experimentalDecorators`, `emitDecoratorMetadata` or `reflect-metadata`. Decorators record
metadata under `knead:`-prefixed keys on the class's `Symbol.metadata` object. Knead polyfills
`Symbol.metadata` because Bun 1.4 does not ship it.

### Explicit injection

TypeScript types are erased at runtime, and Knead does not emit design-time type metadata. So a
class asks for its dependencies explicitly: `readonly users = inject(UsersService)` in a field
initializer. There are no constructor parameter decorators. `inject()` works only synchronously while Knead is
creating an instance: in field initializers, constructors and provider factories. See
[dependency injection](/guide/dependency-injection/).

### Built on Bun

Controllers compile to Bun's native `Bun.serve` router. Redis-backed features (rate-limit stores,
GraphQL pub/sub, schedule locks) use `Bun.redis`, so there is no Redis client dependency. Tests
run with `bun test`.

### Secure by default

Protections that are easy to forget are on from the start: limits on request body size, query
and form parameter counts, GraphQL depth and complexity, and WebSocket message size, rate and
connections per IP. Parsed query, form and JSON objects drop `__proto__`, `constructor` and
`prototype`. Credentials are redacted from logs, and error details are masked outside
development. Guards pass only when they return exactly `true`. See
[security](/guide/security/).

## Packages

Every package is published under the `@knead-js` scope. All of them share one version number.

| Package | What it provides |
| --- | --- |
| [`@knead-js/core`](/packages/core/) | Dependency injection, modules, lifecycle hooks, logger interface, log redaction |
| [`@knead-js/http`](/packages/http/) | `KneadFactory`, controllers, routing, validation, middleware, guards, filters, TLS, WebSockets |
| [`@knead-js/config`](/packages/config/) | Typed, validated configuration from environment variables, async loaders and code |
| [`@knead-js/logging`](/packages/logging/) | `LoggingModule` and `JsonLogger` for JSON structured (NDJSON) logs |
| [`@knead-js/testing`](/packages/testing/) | `Test.createModule`, provider overrides, real ephemeral test servers |
| [`@knead-js/cors`](/packages/cors/) | CORS, including preflight handling |
| [`@knead-js/security-headers`](/packages/security-headers/) | CSP (with nonces), HSTS and other security headers |
| [`@knead-js/rate-limit`](/packages/rate-limit/) | Sliding-window and token-bucket rate limits with memory and Redis stores |
| [`@knead-js/sanitize`](/packages/sanitize/) | Allowlist HTML sanitization, usable as a Standard Schema |
| [`@knead-js/graphql`](/packages/graphql/) | Code-first GraphQL on Leaven, with DataLoader and subscriptions |
| [`@knead-js/casl`](/packages/casl/) | CASL authorization: permission catalog, token grants, REST and GraphQL guards |
| [`@knead-js/schedule`](/packages/schedule/) | `@Cron`, `@Interval` and `@Timeout` jobs, with optional locks so a job runs on one instance |
| [`@knead-js/prisma`](/packages/prisma/) | Prisma 7 lifecycle, ambient `@Transactional` transactions, Prisma error mapping |

`@knead-js/core` is a peer dependency of the other packages. Your application must resolve
exactly one copy of it. Tokens, module metadata and `inject()` depend on module identity, so if
two copies load, core prints a warning naming both.

## Requirements

- **Bun 1.4.3 or newer.** That release fixes CVE-2026-48618 (TLS hostname matching), request
  smuggling through bare-LF chunked bodies and other server bugs. On an older Bun,
  `app.listen()` logs a warning.
- **TypeScript with standard decorators**, meaning `experimentalDecorators` is not enabled. See
  [getting started](/guide/getting-started/#configure-typescript).

## Where to go next

- [Getting started](/guide/getting-started/) builds a small REST API with validation and tests.
- [Modules](/guide/modules/), [dependency injection](/guide/dependency-injection/) and
  [lifecycle](/guide/lifecycle/) explain the core model.
- [Controllers](/guide/controllers/) and the other HTTP pages cover request handling.
- The **Packages** section of the sidebar is the API reference: it lists every export of every
  package.
