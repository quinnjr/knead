# @hpmws/http

HTTP(S) for hpmws: `@Controller` and `@Get`/`@Post`/… compiled into Bun's native router; schema-typed `Ctx` (Standard Schema); middleware, guards and exception filters; RFC 9457 errors; TLS, HTTP→HTTPS redirect (`redirectHttp` requires `tls`), graceful shutdown and a WebSocket endpoint registry (endpoint paths must be exact). `reloadTls()` hot-swaps certificates via `SO_REUSEPORT` and is Linux-only.

A failed `listen()` (for example, the port is taken) binds nothing and can be retried, but the application context stays open. If you give up instead, call `await app.close()` so shutdown hooks run and resources are released:

```ts
try {
  await app.listen({ port: 3000 });
} catch (error) {
  await app.close();
  throw error;
}
```

`bun add @hpmws/core @hpmws/http` (`@hpmws/core` is a peer dependency). Licensed MIT OR Apache-2.0.
