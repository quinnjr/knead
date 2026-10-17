# @knead-js/prisma

## 0.2.0

### Minor Changes

- 7b77d69: Add `@knead-js/prisma`: `PrismaModule.forRoot()` / `forRootAsync()` and `PrismaService`, which connects the Prisma 7 client at bootstrap and disconnects it on shutdown; `TransactionHost` and `@Transactional()` for ambient transactions (`required` and `requiresNew` propagation); `@knead-js/prisma/http` with `PrismaHttpModule`, `PrismaExceptionFilter` and `toHttpException`, mapping Prisma errors to problem responses without exposing their messages; and `@knead-js/prisma/testing` with `withRollback`. Register your client type through `PrismaClientRegistry` to type `PrismaService.db`.
  
  `@knead-js/core` now owns `LOGGER`, `Logger`, `ConsoleLogger`, `MemoryLogger`, `logError` and the `DEVELOPMENT` token, and `ApplicationContext.create` provides a default `LOGGER` and `DEVELOPMENT` and accepts `logger` and `development` options. `@knead-js/http` re-exports the same objects.
  
  `@knead-js/http` exception filters can now decline by returning `undefined`, so later filters and the default mapping still run, and `defaultErrorResponse` is exported. `ExceptionFilter.catch` is typed `Response | undefined | Promise<Response | undefined>` (was `Response | Promise<Response>`). Behaviour change: a filter that returns `undefined` used to be logged as "did not return a Response" and stop the chain with the default mapping; it now passes the error on to the next filter without logging. Other non-`Response` values are still logged and stop the chain.
  
  `HTTP_DEVELOPMENT` is now an alias of core's `DEVELOPMENT` (the same token object), so its description is `'DEVELOPMENT'` rather than `'HTTP_DEVELOPMENT'`; `NoProviderError` messages and other token names in error text change accordingly.
  
  `TransactionHost.run` marks a joined (`required`) transaction rollback-only when an inner run rejects: if the owning run then resolves, the transaction rolls back and the owning run rejects with a `KneadError` whose `cause` is the inner rejection.

### Patch Changes

- f779f8a: Importing `PrismaHttpModule.forRoot()` more than once, or `PrismaHttpModule` without `forRoot()`, fails at startup with a `KneadError`. Before, a second import's `map` was silently ignored (the first filter answered every Prisma error) and a bare import registered no filter.
- Updated dependencies [f779f8a]
- Updated dependencies [5296955]
- Updated dependencies [f779f8a]
- Updated dependencies [7b77d69]
- Updated dependencies [5296955]
- Updated dependencies [82ce070]
- Updated dependencies [871883c]
  - @knead-js/core@0.2.0
  - @knead-js/http@0.2.0
