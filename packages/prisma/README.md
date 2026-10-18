# @knead-js/prisma

[![npm](https://img.shields.io/npm/v/@knead-js/prisma?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/prisma)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

[Prisma ORM](https://www.prisma.io/docs) 7 for Knead applications: a managed client, ambient
transactions that every repository joins, Prisma errors answered as problem responses, and tests
that always roll back.

**[Documentation](https://quinnjr.github.io/knead/packages/prisma/)** · [Guide](https://quinnjr.github.io/knead/guide/database/) · [Knead](https://github.com/quinnjr/knead)

## Install

Prisma 7 talks to the database through a driver adapter. For Postgres, use `@prisma/adapter-pg`:

```bash
bun add @knead-js/core @knead-js/http @knead-js/prisma @prisma/client @prisma/adapter-pg pg
bun add -d prisma
```

Requires Bun 1.4.3 or newer. Peer dependencies: `@knead-js/core`, `@prisma/client` `^7` (optional
to the package manager, but you need it to have a client) and `@knead-js/http` (optional, needed
only for `@knead-js/prisma/http`). Use your database's adapter if it is not Postgres.

The package has no runtime dependencies and never imports `@prisma/client`, not even its types.
Your generated client lives in your project, and you [register its type](#typing-the-client) once.

| Import | Contents |
| --- | --- |
| `@knead-js/prisma` | `PrismaModule`, `PrismaService`, `TransactionHost`, `@Transactional()`, tokens and types |
| `@knead-js/prisma/http` | `PrismaHttpModule` and helpers that answer Prisma errors with problem responses |
| `@knead-js/prisma/testing` | `withRollback()` |

## Quick start

Prisma 7's `prisma-client` generator writes the client into your source tree (here
`src/generated/prisma`; run `bunx prisma generate` after every schema change). Give
`PrismaModule.forRoot()` a factory that builds it with the driver adapter:

```ts
import { Module } from '@knead-js/core';
import { PrismaModule } from '@knead-js/prisma';
import { PrismaHttpModule } from '@knead-js/prisma/http';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { UsersModule } from './users.module.js';

@Module({
  imports: [
    PrismaModule.forRoot({
      client: () =>
        new PrismaClient({
          adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        }),
    }),
    PrismaHttpModule.forRoot(),
    UsersModule,
  ],
})
export class AppModule {}
```

Then query through `PrismaService.db` in your repositories:

```ts
@Injectable()
export class UsersRepository {
  readonly #prisma = inject(PrismaService);

  findById(id: number) {
    // db is the ambient transaction's client inside a transaction, the base client otherwise.
    return this.#prisma.db.user.findUnique({ where: { id } });
  }

  create(email: string, name: string | null) {
    return this.#prisma.db.user.create({ data: { email, name } });
  }

  count() {
    return this.#prisma.db.user.count();
  }
}
```

The module connects the client at bootstrap and disconnects it at shutdown. `PrismaHttpModule`
turns a unique violation into `409 Conflict`, a missing record into `404`, and so on.

## Features

- **Managed client.** `forRoot({ client })` builds, connects and disconnects it; `forRoot({ instance })`
  takes one you own; `forRootAsync()` builds the options from other providers.
- **Typed.** Register your generated `PrismaClient` once and `PrismaService` is fully typed.
- **Ambient transactions.** `@Transactional()` and `TransactionHost.run()` open a transaction that
  every query through `PrismaService.db` joins, with no transaction client to pass around.
- **Safe composition.** An inner failure marks the shared transaction rollback-only, so catching it
  cannot commit half of the work.
- **Errors as HTTP responses.** Prisma errors become `409`, `404`, `400` or `503` problem responses
  with fixed, generic details; Prisma's message never reaches a response or a production log.
- **Fails at startup.** Invalid options, a missing client method or a misused `PrismaHttpModule`
  throw `KneadError` before the first request.
- **Rollback tests.** `withRollback()` runs a test against a real database and confirms the
  rollback, failing closed if it cannot.

## Registering the client

### Typing the client

Tell the package which client you use, once, in any module of your project (for example
`src/prisma.d.ts`):

```ts
import type { PrismaClient } from './generated/prisma/client.js';

declare module '@knead-js/prisma' {
  interface PrismaClientRegistry {
    client: PrismaClient;
  }
}
```

- `PrismaService.client` and the `PRISMA_CLIENT` token are then your `PrismaClient`.
- `PrismaService.db` is a `TxClient`: your client without `$connect`, `$disconnect`, `$on`,
  `$transaction` and `$extends`, which matches what Prisma hands an interactive transaction.
- For a client extended with `$extends()`, register the extended type. Register in one place only:
  two different declarations are a compile error.
- Without the declaration, both fall back to the structural `PrismaLike`, which has no models.

### Module options

| Option | Default | Description |
| --- | --- | --- |
| `client` | | A factory (may be async). The module owns the client: it connects it at bootstrap and disconnects it at shutdown. |
| `instance` | | A client you built and own. It is connected at bootstrap and left connected at shutdown. |
| `disconnectOnShutdown` | `false` | With `instance` only: also disconnect it at shutdown. |

- Give exactly one of `client` and `instance`. The client must have `$connect()`, `$disconnect()`
  and `$transaction()`. Mistakes in the options, and an `instance` of the wrong shape, throw
  `KneadError` when `forRoot()` is called. The client a `client` factory returns is checked at
  bootstrap, which then fails with a `KneadError`.
- `PrismaModule.forRootAsync({ imports, useFactory })` runs `useFactory` in an injection context at
  bootstrap, so it can `inject()` providers exported by `imports`. Its result is validated then;
  the call itself throws `KneadError` unless its options are an object with a `useFactory`
  function and, when given, an `imports` array.
- The module is global and exports `PrismaService`, `TransactionHost` and `PRISMA_CLIENT`.

### Connection failures

A failed `$connect()` aborts bootstrap with a `KneadError` whose message is always
`Prisma failed to connect to the database` and whose `cause` is the original error. A client built
from `client` is disconnected first; an `instance` is left to its owner.

Driver messages can contain connection strings and host names, so the failure is logged through
`LOGGER` by mode:

- Outside development: only the error's name and code, for example
  `Prisma failed to connect: PrismaClientInitializationError (P1001)`. Never the message.
- In development (`NODE_ENV=development`): the full error, with credentials redacted.

Use `PrismaService.client` only for work that must not join the ambient transaction, and for
`$on()` and `$extends()`. Inside a transaction it runs on another connection and cannot see
uncommitted rows.

## Transactions

`@Transactional()` runs an async method in a transaction that every repository call through
`PrismaService.db` joins:

```ts
@Injectable()
export class SignupService {
  readonly #users = inject(UsersRepository);
  readonly #orders = inject(OrdersRepository);
  readonly #audit = inject(AuditLog);

  // Both writes commit together, or neither does.
  @Transactional()
  async signUp(input: SignUp) {
    const user = await this.#users.create(input.email, input.name);
    await this.#orders.create(user.id, input.firstOrderTotal);
    await this.#audit.record(`user.created:${user.id}`);
    return user;
  }
}
```

The transaction commits when the method resolves and rolls back when it rejects; the rejection
reaches the caller unchanged. Checked for you:

- The method must return a `Promise`; a synchronous method is a type error.
- The class must be built by the DI container: `new SignupService()` throws
  `InjectionContextError` instead of running without a transaction.
- A static method, or an unknown `propagation` or `isolationLevel`, throws `KneadError` when the
  class is defined.
- On Bun older than 1.4.3, which can skip the decorator's initializer, calling the method rejects
  with a `KneadError` rather than running without a transaction.

`TransactionHost.run(fn, options?)` does the same for a block, for example
`host.run(() => audit.record(action), { propagation: 'requiresNew' })`. Both take these options;
`run()` rejects with a `KneadError`, before opening a transaction, when `propagation` or
`isolationLevel` is not one of the values below.

| Option | Default | Description |
| --- | --- | --- |
| `isolationLevel` | the database default | `'ReadUncommitted'`, `'ReadCommitted'`, `'RepeatableRead'`, `'Serializable'` or `'Snapshot'`. |
| `timeout` | Prisma's (5000 ms) | Milliseconds the transaction may run before Prisma rolls it back. |
| `maxWait` | Prisma's | Milliseconds to wait for a connection. |
| `propagation` | `'required'` | `'required'` joins the active transaction; `'requiresNew'` opens a separate one. |

### Propagation

- `'required'` joins the active transaction and ignores the inner call's options (in development a
  mismatch logs a warning).
- A joined call that rejects marks the transaction rollback-only. If the owner catches that and
  resolves anyway, the transaction rolls back and the owner's `run()` rejects with a `KneadError`
  whose `cause` is the inner rejection.
- `'requiresNew'` runs on a second connection, so the pool needs at least 2 connections, and it can
  deadlock against the outer transaction when both touch the same rows. Keep it for work that must
  commit independently, such as audit records.

### Limits of the ambient transaction

The transaction is carried by an `AsyncLocalStorage` owned by the application's
`TransactionHost`, so two applications in one process never share one.

- It lasts as long as the callback. `await` everything you start: a fire-and-forget query finds the
  transaction closed and fails.
- Do not start long-lived background work (intervals, batch loops, lazily started singletons)
  inside a transaction. It keeps seeing the closed transaction forever.
- Work that outlives a `requiresNew` run sees the closed inner transaction and fails, rather than
  silently joining the outer one.
- Concurrent queries on one transaction (`Promise.all` inside `run()`) are serialized or rejected,
  depending on the driver adapter. Await them one at a time.

## Errors as HTTP responses

Import `PrismaHttpModule.forRoot()` from `@knead-js/prisma/http`, as the quick start does. It
registers `PrismaExceptionFilter`, which answers Prisma errors and declines every other error:

| Prisma error | Status | `detail` |
| --- | --- | --- |
| `P2002` (unique constraint) | 409 | `A record with these values already exists.` |
| `P2003` (foreign key constraint) | 409 | `The operation conflicts with a related record.` |
| `P2025` (record not found) | 404 | `The requested record was not found.` |
| `P2000` (value too long) | 400 | `A value is too long for its field.` |
| `PrismaClientValidationError` | 400 | `The request could not be processed.` |
| `P1001`, `P1002`, `P2024`, `PrismaClientInitializationError` | 503 | `The database is temporarily unavailable.` |
| any other Prisma error | 500 | none |

Security trade-offs:

- Prisma's `message` is never copied into a response or a production log: it can contain query
  fragments, column values and connection details. The original error travels only as `cause`.
- Each `detail` is fixed and generic. Outside development, 5xx responses follow the default error
  handling and carry only `type`, `title`, `status`, `instance` and a `correlationId` that matches
  the logged error, so the 503 `detail` is dropped too.
- In development, the built-in mappings add `prismaCode` and, when the error's metadata names the
  constraint's fields, `fields` (field names only, never values). `@prisma/adapter-pg` 7.10+
  names the violated unique index instead, so Postgres unique violations carry no `fields`.
- Errors are recognized by exact `name`, not `instanceof`, so a client generated into another copy
  or realm still matches, and no runtime import of `@prisma/client` is needed.

Import `PrismaHttpModule.forRoot()` once, in the root module. Importing `forRoot()` more than once
(the second `map` would never be consulted), or `PrismaHttpModule` without `forRoot()` (no filter
would be registered), fails at startup with a `KneadError`.

`map` overrides or adds mappings, keyed by error code or error name:

```ts
@Module({
  imports: [
    PrismaHttpModule.forRoot({
      map: {
        // P2034: a write conflict or deadlock; ask the client to retry.
        P2034: () =>
          new ServiceUnavailableException('Retry the request.', {
            headers: { 'retry-after': '1' },
          }),
      },
    }),
  ],
})
export class PrismaErrorsModule {}
```

- Keys are looked up as own properties only, code first, then name.
- A mapper that throws, or returns something other than an `HttpException`, produces a masked
  `500`.
- `map` must be a plain object whose values are all functions; anything else throws `KneadError`
  from `forRoot()`. A frozen copy of the options, and of `map`, is stored.

For GraphQL resolvers or your own filters, `toHttpException(error, { map, development })` returns
the same `HttpException` (or `undefined` for non-Prisma errors), and `isPrismaError()` tells you
whether an error is one.

## Shutdown

Call `app.enableShutdownHooks()` in your entry point so SIGTERM and SIGINT close the application:
the HTTP server drains in-flight requests first, then modules are destroyed and the client
disconnects. Without it a signal kills the process with transactions still open.

## Testing

For unit tests, replace the client with a fake: `overrideProvider(PRISMA_CLIENT).useValue(fake)`.
`PrismaService` and `TransactionHost` both read that token, so one override covers both. The fake
needs `$connect()`, `$disconnect()`, `$transaction(fn, options)` and the models your code uses.

Against a real database, `withRollback(moduleRef, fn)` from `@knead-js/prisma/testing` runs `fn`
in a transaction that is always rolled back, so what it writes through `PrismaService.db` in that
transaction does not persist. `moduleRef` is a `TestingModule`, an `ApplicationContext` or anything with `get(token)`.
Point these tests at a disposable database through a variable of their own, never `DATABASE_URL`.

- It resolves with the function's value, and errors thrown by the function propagate unchanged.
- Inner `@Transactional()` calls join the test's transaction, as they would join the owning
  transaction in production: if one rejects, `withRollback()` rejects with the rollback-only
  `KneadError` (its `cause` is the inner rejection), even when the function caught it.
- Inner runs with `propagation: 'requiresNew'` open a transaction of their own, which commits for
  real: the test's rollback does not undo it. Clean up after them yourself.
- The default `timeout` is 30 seconds. It uses `requiresNew`, so the pool needs at least 2
  connections.
- It fails closed: if the transaction does not end in the rollback it asked for, it throws a
  `KneadError` (`withRollback: rollback not confirmed`).
- Requests sent to a real server (`listen()` and `fetch`) run in their own async context, outside
  the test's transaction, and commit for real. Clean up after them yourself.

## Documentation

- [Database guide](https://quinnjr.github.io/knead/guide/database/): schema, setup, repositories,
  transactions, error mapping and testing, with complete examples.
- [`@knead-js/prisma` reference](https://quinnjr.github.io/knead/packages/prisma/): every export,
  option and error message.
- [Exception filters](https://quinnjr.github.io/knead/guide/exception-filters/) and
  [lifecycle](https://quinnjr.github.io/knead/guide/lifecycle/).

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
