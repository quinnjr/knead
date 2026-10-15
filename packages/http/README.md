# @hpmws/http

HTTP(S) for hpmws: `@Controller` and `@Get`/`@Post`/… compiled into Bun's native router; schema-typed `Ctx` (Standard Schema); middleware, guards and exception filters; RFC 9457 errors; TLS, HTTP→HTTPS redirect (`redirectHttp` requires `tls`), graceful shutdown and a WebSocket endpoint registry (endpoint paths must be exact). `reloadTls()` hot-swaps certificates via `SO_REUSEPORT` and is Linux-only.

`bun add @hpmws/core @hpmws/http` (`@hpmws/core` is a peer dependency). Licensed MIT OR Apache-2.0.
