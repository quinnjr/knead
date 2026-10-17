---
'@knead-js/core': minor
'@knead-js/http': minor
'@knead-js/prisma': minor
---

Add `@knead-js/prisma`: `PrismaModule.forRoot()` / `forRootAsync()` and `PrismaService`, which connects the Prisma 7 client at bootstrap and disconnects it on shutdown; `TransactionHost` and `@Transactional()` for ambient transactions (`required` and `requiresNew` propagation); `@knead-js/prisma/http` with `PrismaHttpModule`, `PrismaExceptionFilter` and `toHttpException`, mapping Prisma errors to problem responses without exposing their messages; and `@knead-js/prisma/testing` with `withRollback`. Register your client type through `PrismaClientRegistry` to type `PrismaService.db`.

`@knead-js/core` now owns `LOGGER`, `Logger`, `ConsoleLogger`, `MemoryLogger`, `logError` and the `DEVELOPMENT` token, and `ApplicationContext.create` provides a default `LOGGER` and `DEVELOPMENT` and accepts `logger` and `development` options. `@knead-js/http` re-exports the same objects.

`@knead-js/http` exception filters can now decline by returning `undefined`, so later filters and the default mapping still run, and `defaultErrorResponse` is exported.
