# @knead-js/prisma

## 0.5.0

### Minor Changes

- 151bf6c: **Breaking:** `@Injectable()` is now required on every class the container constructs as a
  provider, whether listed in `providers` or used through `useClass` (including testing overrides).
  An unmarked class is a `ProviderConfigError` at bootstrap naming the class and module. Value,
  factory and alias providers, and guard, middleware and filter classes, need no decorator.
  `@Controller()`, `@Resolver()` and `@Catch()` mark their classes. New `markInjectable(metadata)`
  lets other class decorators do the same; `normalizeProvider()` takes an optional `owner` for its
  error messages.

### Patch Changes

- Updated dependencies [151bf6c]
  - @knead-js/core@0.5.0
  - @knead-js/http@0.5.0

## 0.4.0

### Patch Changes

- 141cdf4: Review fixes:
  
  - `@knead-js/security-headers`: a `script-src` (or `style-src`) set to `true` gets the CSP nonce
    alone instead of inheriting the `default-src` sources.
  - `@knead-js/casl`: `validateGrant()` no longer approves a pair the user is denied by a later
    unconditional `cannot`; a method's `@Can()` now overrides its controller's `@SkipAbility()`
    (it failed open), while `@SkipAbility()` still wins on the same method or controller.
  - `@knead-js/prisma`: `withRollback()` rejects with the rollback-only `KneadError` when an inner
    `@Transactional()` call failed, even if the test function caught it, as the owning run does in
    production.
  - `@knead-js/core`: exports `errorText()` and `isPlainObject()`, now shared by
    `@knead-js/logging` and `@knead-js/prisma/http`; `redactValue()` prints an Error whose `stack`
    is not a string as `Name: message` instead of `[unloggable value: …]`.
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
- Updated dependencies [141cdf4]
  - @knead-js/core@0.4.0
  - @knead-js/http@0.4.0

## 0.3.0

### Patch Changes

- 404aa0d: Fix conformance gaps found by a project-wide audit:
  
  - `redactValue` no longer returns a `Headers`, `Map` or other entries-like object unredacted at the depth limit or inside a cycle, and now redacts non-`Error` causes and `AggregateError.errors` deeper in a cause chain.
  - `JsonLogger` in development no longer hangs on an error that contains itself, and nested errors share the depth limit (at most 100 detailed errors per record).
  - Transients resolved after startup are no longer tracked for lifecycle hooks (an unbounded leak).
  - WebSocket endpoints are reachable behind a covering `/:param` or wildcard GET route; an explicit `undefined` no longer overrides WebSocket defaults; upgrade slots of sockets that never open are released.
  - CORS origin predicates, GraphQL `refreshContext` and revocation checks fail closed on non-`true`/non-object results.
  - More options are validated at startup instead of failing per request: route `status`, `defaultCacheControl`, security-header and CSP values Bun cannot send, CORS `origin`, rate-limit `store`/`key`/`middleware`, `sweepIntervalMs`, GraphQL `cacheControl`/CSRF headers/timeouts, sanitize preset names, `PrismaModule.forRootAsync` and `TransactionHost.run` `isolationLevel`.
  - The rate-limit Redis store's own client no longer queues commands while Redis is unreachable; the scheduler logs through the application `LOGGER`; cron jobs no longer re-fire during a DST fall-back hour; cron patterns are capped at 1024 characters.
  - Per-request work is cached (CORS and security headers, playground pages, interface resolution, route 405 lookup), and packages gain npm keywords, homepages and Bun-oriented descriptions.
- Updated dependencies [404aa0d]
- Updated dependencies [bebabd2]
- Updated dependencies [d35aafe]
  - @knead-js/core@0.3.0
  - @knead-js/http@0.3.0

## 0.2.1

### Patch Changes

- d0fcac9: Documents that `@prisma/adapter-pg` 7.10 and later report a violated unique index by name (`constraint.index`) rather than by its fields, so in development a Postgres unique violation's problem response has `prismaCode` but no `fields`. Tested against Prisma 7.10.1.
- @knead-js/core@0.2.1
  - @knead-js/http@0.2.1

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
