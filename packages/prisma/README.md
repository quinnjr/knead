# @knead-js/prisma

Prisma 7 integration for Knead: `PrismaModule.forRoot()` / `forRootAsync()`, an injectable `PrismaService` whose `db` joins the ambient transaction, `TransactionHost` and `@Transactional()` for request-spanning transactions without passing a client around, `@knead-js/prisma/http` to answer Prisma errors with problem responses, and `@knead-js/prisma/testing` for `withRollback`. The package has no runtime dependencies and never imports `@prisma/client`, not even its types: the generated client lives in your project, so you register its type once and the library stays structural.

Requires Bun >= 1.4.3. Older Bun skips `@Transactional`'s initializer when another decorated class follows in the same scope; calling the decorated method then rejects with a `KneadError` that names this requirement, rather than running without a transaction. `@prisma/client` ^7 is an optional peer dependency (you need it to have a client at all); `@knead-js/http` is an optional peer, needed only for `@knead-js/prisma/http`.

## Setup

Prisma 7 needs a driver adapter; for Postgres use `pg`:

```
bun add @knead-js/core @knead-js/prisma @prisma/client @prisma/adapter-pg pg
bun add -d prisma
```

```ts
import { Module } from '@knead-js/core';
import { PrismaModule } from '@knead-js/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    PrismaModule.forRoot({
      client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
    }),
  ],
})
class AppModule {}
```

`client` is a factory, so the module owns the instance it builds: it connects at bootstrap and disconnects on shutdown. `forRoot({ instance })` takes a client you built and manage yourself; it is connected at bootstrap but only disconnected with `disconnectOnShutdown: true`. `forRootAsync({ imports, useFactory })` resolves the options from other providers. The module is global and exports `PrismaService`, `TransactionHost` and the `PRISMA_CLIENT` token. Options are checked when `forRoot()` is called (or when the async factory resolves): giving both or neither of `client` and `instance`, or a client without `$connect`, `$disconnect` and `$transaction`, is a `KneadError` at bootstrap, never at request time.

A failed `$connect` aborts bootstrap with a `KneadError` whose message is fixed (`Prisma failed to connect to the database`) and whose `cause` is the original error. Connection strings can appear in driver error messages, so the original is logged through the injected `LOGGER` only after credential redaction.

### Typing the client

Merge your generated client into the registry once, in any `.d.ts` or module of your project:

```ts
import type { PrismaClient } from './generated/prisma/client.js';

declare module '@knead-js/prisma' {
  interface PrismaClientRegistry {
    client: PrismaClient;
  }
}
```

`PrismaService.client` is then your `PrismaClient`, and `PrismaService.db` is `TxClient`: that client minus `$connect`, `$disconnect`, `$on`, `$transaction` and `$extends`, matching what Prisma gives an interactive transaction. An extended client (`$extends`) works if you register the extended type. Without the declaration both fall back to a structural `PrismaLike`.

```ts
class UserRepository {
  readonly prisma = inject(PrismaService);

  find(id: string) {
    return this.prisma.db.user.findUnique({ where: { id } });
  }
}
```

Use `prisma.db` in repositories: it is the active transaction's client inside `run()` and the base client otherwise. Use `prisma.client` for work that must escape the ambient transaction, `$on`, or `$extends`.

## Transactions

```ts
const host = inject(TransactionHost);
await host.run(async () => {
  await users.create(data); // both use prisma.db, so both join the transaction
  await audit.record('user.created');
}, { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 2_000 });
```

`run` commits when the callback resolves, rolls back when it rejects and rethrows the rejection unchanged. Options are `isolationLevel` (`'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable' | 'Snapshot'`), `timeout`, `maxWait` and `propagation`. Prisma's own default `timeout` is 5 seconds; raise it for slow work. `host.isActive` reports whether the current async context is inside an open transaction.

`@Transactional(options?)` wraps an async method in `host.run`:

```ts
class OrderService {
  readonly orders = inject(OrderRepository);

  @Transactional({ isolationLevel: 'RepeatableRead' })
  async place(input: OrderInput) { /* ... */ }
}
```

The class must be built by the container: the decorator takes `TransactionHost` from `inject()` while the instance is constructed, so `new OrderService()` throws `InjectionContextError` instead of quietly running without a transaction. It applies to instance methods that return a `Promise`; a synchronous method is a type error. Decorating a static method, or passing a `propagation` or `isolationLevel` that is not one of the values listed here, is a `KneadError` when the class is defined; `run()` likewise rejects with a `KneadError` for an unknown `propagation`.

Propagation: `'required'` (the default) joins the active transaction, and the inner call's options are ignored (in development a mismatch logs a warning through `LOGGER`). A joined run that rejects marks the shared transaction rollback-only: the rejection reaches the inner caller unchanged, but if the owning `run()` then resolves anyway (because it caught that rejection), the transaction is rolled back rather than committed and the owning `run()` rejects with a `KneadError` (`transaction marked rollback-only by an inner failure`) whose `cause` is the first inner rejection. Catching an inner failure therefore cannot commit half of the work; use `'requiresNew'` for work whose failure the outer transaction should survive. `'requiresNew'` always opens a separate transaction on another connection. That needs a connection pool of at least 2, and it can deadlock against the outer transaction when both touch the same rows, because the outer one holds its locks while the inner one waits for them. Keep `requiresNew` for work that must commit independently, such as audit records.

Limits, all from the way the transaction is carried (an `AsyncLocalStorage` per `TransactionHost`, so two apps in one process never share transactions):

- The transaction lasts as long as the callback. Work started inside `run()` but awaited after it settles (a fire-and-forget promise) finds the transaction closed, and Prisma fails the query loudly instead of letting it escape. `await` everything you start.
- Do not start long-lived background work inside `run()`: intervals, batch loops, or a lazily created singleton that starts its own loop on first use. `AsyncLocalStorage` captures the transaction context, so that work keeps seeing a closed transaction forever. Create such things at bootstrap or outside any transaction.
- A closed transaction frame hides any enclosing one. Work that outlives a `requiresNew` run therefore sees the closed inner transaction, not the still-open outer one, and fails rather than silently joining the outer.
- Concurrent queries on one interactive transaction (`Promise.all` inside `run()`) are serialized or rejected depending on the driver adapter. Await them one at a time.
- Using `prisma.client` inside `run()` bypasses the transaction. That is sometimes intended, but it runs on a different connection and cannot see uncommitted rows.

## Shutdown

Call `app.enableShutdownHooks()` so SIGTERM and SIGINT close the application: the HTTP server drains first, then modules are destroyed and the client disconnects. Without it a signal kills the process with transactions still open and connections unreleased. Transactions still in flight when `$disconnect()` runs are subject to Prisma's own behaviour; let requests finish (drain) before the module is destroyed, which the shutdown order already does.

## HTTP error mapping

```ts
import { PrismaHttpModule } from '@knead-js/prisma/http';

@Module({ imports: [PrismaModule.forRoot({ /* ... */ }), PrismaHttpModule.forRoot()] })
class AppModule {}
```

`PrismaHttpModule.forRoot({ map })` registers `PrismaExceptionFilter` as an `APP_FILTER`. It answers Prisma errors with the same problem response the default mapping produces for that `HttpException`, including masking of 5xx details outside development and correlation-id logging, and declines (returns `undefined`) for every other error so later filters and the default mapping still apply. Errors are recognised by exact `name`, not `instanceof`, so a client generated into another copy or realm still matches and no runtime import of `@prisma/client` is needed.

| Prisma error | Status | Exception |
|---|---|---|
| `P2002` unique constraint | 409 | `ConflictException` |
| `P2003` foreign key | 409 | `ConflictException` |
| `P2025` record not found | 404 | `NotFoundException` |
| `P2000` value too long | 400 | `BadRequestException` |
| `PrismaClientValidationError` | 400 | `BadRequestException` |
| `P1001`, `P1002`, `P2024` (unreachable, timeout, pool timeout), `PrismaClientInitializationError` | 503 | `ServiceUnavailableException` |
| any other Prisma error | 500 | `InternalServerErrorException` |

Security trade-off: each row has a fixed, generic `detail`. Prisma's `message` is never copied into a response body or a production log, because it can contain query fragments, column values and connection details; the original error travels only as `cause`. In development, responses additionally carry `extensions.prismaCode` and, for unique violations, `extensions.fields` (field names from `meta.target`, never values).

`map` overrides or adds mappers by code (`P2034`) or by error name; a mapper that throws or returns something other than an `HttpException` becomes a 500:

```ts
PrismaHttpModule.forRoot({ map: { P2034: () => new ServiceUnavailableException('Retry the request.') } });
```

`toHttpException(error, { map, development })` and `isPrismaError(error)` are exported for your own filters or for GraphQL resolvers; `toHttpException` returns `undefined` for errors that are not Prisma's.

## Testing

Replace the client with a fake: `overrideProvider(PRISMA_CLIENT).useValue(fake)`. `PrismaService` and `TransactionHost` both read the client from that token, so one override covers both, and the fake needs only `$connect`, `$disconnect`, `$transaction` and the models you use.

For tests against a real database, `withRollback` from `@knead-js/prisma/testing` runs a function inside a transaction that is always rolled back and resolves with the function's value:

```ts
import { withRollback } from '@knead-js/prisma/testing';

test('creates a user', async () => {
  await withRollback(moduleRef, async () => {
    await moduleRef.get(UserService).create({ email: 'a@example.com' });
    expect(await moduleRef.get(UserService).count()).toBe(1);
  });
  // rolled back: nothing persists
});
```

`moduleRef` is anything with `get(token)`, such as a `TestingModule` or `ApplicationContext`. Errors thrown by the function propagate unchanged; the default `timeout` is 30 seconds, because Prisma's 5 seconds is too short for tests. It uses `requiresNew`, so the pool needs at least 2 connections.

`withRollback` does not cover requests made through a real ephemeral server (`listen()` plus `fetch`). Those run in a separate async context, never see the test's transaction, and commit for real. Clean up after such tests yourself, or test controllers through service calls inside `withRollback`.

The package's own Postgres suite runs with `pnpm --filter @knead-js/prisma test:db` and `DATABASE_URL` set (see AGENTS.md); it resets the target database, so point it at a disposable one.

`bun add @knead-js/core @knead-js/prisma` (`@knead-js/core` is a peer dependency, so every package shares one copy; add `@knead-js/http` for `/http`). Licensed MIT OR Apache-2.0.
