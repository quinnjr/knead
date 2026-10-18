---
title: Database
description: Connect Prisma 7 to a Knead application, query through repositories that join an ambient transaction, answer database errors with problem responses, and test against a rolled-back transaction.
---

`@knead-js/prisma` integrates [Prisma ORM](https://www.prisma.io/docs) 7 with Knead. It gives you:

- `PrismaModule`, which creates, connects and disconnects your Prisma client;
- `PrismaService`, whose `db` property is the client to query through;
- `TransactionHost` and `@Transactional()`, which run work in a transaction that every repository
  joins automatically, without passing a transaction client around;
- `@knead-js/prisma/http`, which turns Prisma errors into problem responses (`409` for a unique
  violation, `404` for a missing record, and so on);
- `@knead-js/prisma/testing`, whose `withRollback()` runs a test inside a transaction that is
  always rolled back.

The package never imports `@prisma/client`, not even its types, and has no runtime dependencies.
Your generated client lives in your project, and you register its type once. The
[package reference](/packages/prisma/) lists every export.

## Installing

Prisma 7 talks to the database through a driver adapter. For Postgres, use `@prisma/adapter-pg`:

```bash
bun add @knead-js/prisma @prisma/client @prisma/adapter-pg pg
bun add -d prisma
```

`@knead-js/core` is a peer dependency. `@knead-js/http` is an optional peer, needed only for
`@knead-js/prisma/http`. The package requires Bun 1.4.3 or later (see
[`@Transactional()`](#transactional-methods) for why).

## The schema and the generated client

The examples on this page use this schema. Prisma 7's `prisma-client` generator writes the client
into your source tree, here `src/generated/prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String?
  orders Order[]
}

model Order {
  id     Int  @id @default(autoincrement())
  userId Int
  total  Int
  user   User @relation(fields: [userId], references: [id])
}

model AuditEntry {
  id     Int    @id @default(autoincrement())
  action String
}
```

Run `bunx prisma generate` after every schema change. The connection URL for the Prisma CLI
(migrations, `db push`) lives in `prisma.config.ts` in Prisma 7, not in the schema; see the Prisma
documentation. At run time, your application passes the URL to the driver adapter.

The generated client exports `PrismaClient` and a type per model. For this schema, the records
look like this:

<<< prisma/generated/prisma/client.ts#models title="src/generated/prisma (record shapes)"

## Registering the client

Import `PrismaModule.forRoot()` in the root module and give it a `client` factory:

<<< prisma/app.module.ts#module title="app.module.ts"

Because `client` is a factory, the module owns the client it builds: it calls `$connect()` while
the application bootstraps and `$disconnect()` when it shuts down. The factory may be async. The
module is global and exports `PrismaService`, `TransactionHost` and the `PRISMA_CLIENT` token.
`PrismaHttpModule` is covered in [errors as HTTP responses](#errors-as-http-responses).

Options are checked when `forRoot()` is called, so a mistake fails before the application starts:
the options need exactly one of `client` and `instance`, and the client must have `$connect()`,
`$disconnect()` and `$transaction()` methods. Each problem is a `KneadError` such as
`PrismaModule options need exactly one of \`client\` or \`instance\`.`

### Typing the client

Tell the package which client you use, once, in any module of your project:

<<< prisma/registry.ts title="src/prisma.d.ts"

This merges your `PrismaClient` into the package's `PrismaClientRegistry` interface. From then on,
`PrismaService.client` is your `PrismaClient`, `PRISMA_CLIENT` injects it, and `PrismaService.db`
is a `TxClient`: your client without `$connect`, `$disconnect`, `$on`, `$transaction` and
`$extends`, which matches what Prisma hands an interactive transaction. If you use a client
extended with `$extends()`, register the extended type. Without the declaration, both fall back to
the structural `PrismaLike` type, which has no models.

> [!IMPORTANT]
> Register the client in exactly one place. Two declarations of `client` with different types are
> a compile error.

### Building options from other providers

`PrismaModule.forRootAsync({ imports, useFactory })` resolves the options at bootstrap. The factory
runs in an injection context, so it can `inject()` providers exported by `imports`, and it may be
async:

<<< prisma/registration.ts#async title="app.module.ts"

The resolved options are validated the same way, at bootstrap.

### Bringing your own client

`forRoot({ instance })` takes a client you built. The module connects it at bootstrap but leaves
it connected at shutdown, because its owner (you) may still use it. Pass
`disconnectOnShutdown: true` to have the module disconnect it too:

<<< prisma/instance.ts#instance title="app.module.ts"

### Connection failures

If `$connect()` fails, bootstrap aborts with a `KneadError` whose message is always
`Prisma failed to connect to the database` and whose `cause` is the original error. A client the
module built from `client` is disconnected first; an `instance` is left to its owner.

Driver error messages can contain connection strings and host names, so the failure is logged
through the injected `LOGGER` differently by mode:

- Outside development, only the error's name and its `code` or `errorCode`, for example
  `Prisma failed to connect: PrismaClientInitializationError (P1001)`. Never the message.
- In development (`NODE_ENV=development`), the full error, with credentials redacted.

## Querying through repositories

Inject `PrismaService` and query through `db`:

<<< prisma/users.repository.ts#repository title="users.repository.ts"

`db` is the client of the active transaction when there is one in the current async context, and
the base client otherwise. Written this way, a repository works both inside and outside a
transaction without knowing which.

Repositories and the services that use them are ordinary providers:

<<< prisma/users.module.ts title="users.module.ts"

`PrismaService.client` is the base client. Use it for work that must not join the ambient
transaction, and for `$on()` and `$extends()`. Inside a transaction, a query through `client` runs
on another connection and cannot see the transaction's uncommitted rows.

## Transactions

### Transactional methods

`@Transactional()` runs an async method inside a transaction. Every repository call it makes
through `PrismaService.db` joins that transaction:

<<< prisma/users.service.ts#transactional title="signup.service.ts"

The transaction commits when the method resolves. When it rejects, the transaction rolls back and
the rejection reaches the caller unchanged.

Rules that are checked for you:

- The decorated method must return a `Promise`. A synchronous method is a type error.
- The class must be built by the DI container, because the decorator takes `TransactionHost` with
  `inject()` while the instance is constructed. `new SignupService()` throws
  `InjectionContextError` instead of quietly running without a transaction.
- A static method, or a `propagation` or `isolationLevel` that is not one of the values below, is
  a `KneadError` when the class is defined.

> [!NOTE]
> Bun versions before 1.4.3 can skip the decorator's initializer when another decorated class
> follows in the same scope. Calling the method then rejects with a `KneadError` that names this
> requirement, rather than running without a transaction.

### Running a block in a transaction

`TransactionHost.run(fn, options?)` is the same thing as a function call. Use it when the
transaction should cover only part of a method, or when you need options computed at run time:

<<< prisma/users.service.ts#run title="import.service.ts"

The options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `isolationLevel` | `IsolationLevel` | the database default | `'ReadUncommitted'`, `'ReadCommitted'`, `'RepeatableRead'`, `'Serializable'` or `'Snapshot'`. Which ones work depends on the database. |
| `timeout` | `number` | Prisma's default (5000 ms) | Longest time, in milliseconds, the transaction may run before Prisma rolls it back. |
| `maxWait` | `number` | Prisma's default | Longest time, in milliseconds, to wait for a connection. |
| `propagation` | `Propagation` | `'required'` | `'required'` or `'requiresNew'`; see below. |

`isolationLevel`, `timeout` and `maxWait` are passed to Prisma's `$transaction()`; options you
leave out are not passed at all. `host.isActive` tells you whether the current async context is
inside an open transaction.

### Propagation

`'required'` (the default) joins the active transaction if there is one and opens a new one
otherwise. A joined call's own options are ignored, since the transaction already exists; in
development, joining with different options logs a warning through `LOGGER`.

A joined call that rejects marks the shared transaction rollback-only. The rejection still reaches
the inner caller unchanged. But if the owner then resolves anyway, because it caught that
rejection, the transaction is rolled back rather than committed, and the owner's `run()` rejects
with a `KneadError` (`TransactionHost: transaction marked rollback-only by an inner failure`)
whose `cause` is the first inner rejection. Catching an inner failure therefore cannot commit half
of the work.

`'requiresNew'` always opens a separate transaction, as `recordAttempt()` does above: the audit
entry commits even if the caller's transaction later rolls back, and its failure does not mark the
outer transaction. Use it sparingly:

- It runs on a second connection, so the connection pool needs at least 2 connections.
- It can deadlock against the outer transaction when both touch the same rows: the outer one holds
  its locks while the inner one waits for them.

### What the ambient transaction cannot do

The transaction is carried by an `AsyncLocalStorage` that belongs to the application's
`TransactionHost`, so two applications in one process never share a transaction. That has a few
consequences:

- The transaction lasts as long as the callback. Work started inside it but awaited after it
  settles (a fire-and-forget promise) finds the transaction closed, and Prisma fails the query
  instead of letting it run outside the transaction. `await` everything you start.
- Do not start long-lived background work inside a transaction: intervals, batch loops, or a lazily
  created singleton that starts its own loop on first use. It captures the transaction context and
  keeps seeing a closed transaction forever. Create such things at bootstrap.
- Work that outlives a `requiresNew` run sees the closed inner transaction, not the still-open
  outer one, and fails rather than silently joining the outer transaction.
- Concurrent queries on one interactive transaction (`Promise.all` inside `run()`) are serialized
  or rejected, depending on the driver adapter. Await them one at a time.

## Errors as HTTP responses

Without help, a Prisma error thrown from a controller is an unhandled error: a `500`. Import
`PrismaHttpModule.forRoot()` from `@knead-js/prisma/http` (as the root module above does) to
answer Prisma errors with the right status:

<<< prisma/users.controller.ts#controller title="users.controller.ts"

A second sign-up with the same email now gets:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json; charset=utf-8

{"type":"about:blank","title":"Conflict","status":409,"detail":"A record with these values already exists.","instance":"/users"}
```

The transaction around `signUp()` rolled back, so nothing was written.

The mapping:

| Prisma error | Status | `detail` |
| --- | --- | --- |
| `P2002` (unique constraint) | 409 | `A record with these values already exists.` |
| `P2003` (foreign key constraint) | 409 | `The operation conflicts with a related record.` |
| `P2025` (record not found) | 404 | `The requested record was not found.` |
| `P2000` (value too long) | 400 | `A value is too long for its field.` |
| `PrismaClientValidationError` | 400 | `The request could not be processed.` |
| `P1001`, `P1002`, `P2024` (database unreachable, timed out, pool timeout) | 503 | `The database is temporarily unavailable.` |
| `PrismaClientInitializationError` | 503 | `The database is temporarily unavailable.` |
| any other Prisma error | 500 | none |

Codes are matched first, then error names. Errors are recognized by their exact `name`
(`PrismaClientKnownRequestError` and the other four Prisma error classes), not with `instanceof`,
so a client generated into another copy or realm still matches. Every other error is declined and
goes on to later filters and the default error handling.

What the response contains:

- Prisma's `message` is never copied into a response or a production log: it can contain query
  fragments, column values and connection details. The original error travels only as the
  exception's `cause`.
- 5xx responses follow the default error handling: outside development they carry only `type`,
  `title`, `status`, `instance` and a `correlationId` that matches the logged error, so the fixed
  503 `detail` is dropped too.
- In development, the built-in mappings add `prismaCode` (the error code) and, when the error's metadata names
  the constraint's fields, `fields` (field names only, never values). Prisma 7 driver adapters put
  them at `meta.driverAdapterError.cause.constraint.fields`; `meta.target` is used otherwise.
  `@prisma/adapter-pg` 7.10 and later name a violated unique index (`constraint.index`) rather
  than its fields, so a Postgres unique violation carries no `fields`.

See [exception filters](/guide/exception-filters/) for how filters are ordered.

### Custom mappings

`map` overrides or adds mappings, keyed by error code or by error name. A mapper receives the
Prisma error and returns an `HttpException`:

<<< prisma/http-errors.ts#map title="prisma-errors.module.ts"

- Keys are looked up as own properties only, code first, then name.
- A mapper that throws, or returns something that is not an `HttpException`, produces a masked
  `500`.
- `map` must be a plain object whose values are all functions; anything else is a `KneadError`
  from `forRoot()`. The module stores a frozen copy, so changing the object later has no effect.
- The response follows the usual rules: in this example the `503` keeps its `retry-after` header
  in production, but its `detail` is shown only in development.

> [!NOTE]
> Import `PrismaHttpModule.forRoot()` once, in the root module. A second import (whose `map` would
> never be consulted, since the first filter answers every Prisma error) fails at startup with
> `KneadError: PrismaHttpModule.forRoot() is imported 2 times; import it once, in the root module`,
> and importing `PrismaHttpModule` without `forRoot()` fails with
> `Import PrismaHttpModule.forRoot(), not PrismaHttpModule`.

For GraphQL resolvers or your own filters, `toHttpException(error, { map, development })` returns
the same `HttpException` (or `undefined` for errors that are not Prisma's), and `isPrismaError()`
tells you whether an error is one.

## Shutdown

Call `app.enableShutdownHooks()` in your entry point so that SIGTERM and SIGINT close the
application: the HTTP server drains in-flight requests first, then modules are destroyed and
`PrismaService` disconnects the client. Without it a signal kills the process with transactions
still open. See [lifecycle](/guide/lifecycle/).

## Testing

### With a fake client

For unit tests, replace the client with a fake:
`Test.createModule({ imports: [AppModule] }).overrideProvider(PRISMA_CLIENT).useValue(fake)`.
`PrismaService` and `TransactionHost` both read the client from that token, so one override
covers both. The fake needs `$connect()`, `$disconnect()`, a `$transaction(fn, options)` that calls
`fn` with a transaction client, and the models your code uses. Often it is simpler to override
your repositories instead. See [testing](/guide/testing/).

### Against a real database

`withRollback(moduleRef, fn, options?)` from `@knead-js/prisma/testing` runs `fn` inside a
transaction that is always rolled back, and resolves with `fn`'s value. Everything `fn` does
through `PrismaService.db` joins that transaction, so nothing persists:

<<< prisma/signup.test.ts#rollback title="signup.service.test.ts"

- `moduleRef` is anything with `get(token)`, such as a `TestingModule` or an
  `ApplicationContext`.
- Errors thrown by `fn` propagate unchanged.
- Inner `@Transactional()` calls join the test's transaction, exactly as they join the
  outermost transaction in production. If one of them rejects, the transaction is rollback-only:
  even when `fn` catches the error, `withRollback()` rejects with the `KneadError`
  `TransactionHost: transaction marked rollback-only by an inner failure` (its `cause` is the
  inner rejection), as the owning `@Transactional()` method would in production.
- The default `timeout` is 30 seconds, because Prisma's 5-second default is short for tests. Pass
  `{ timeout }` to change it.
- It opens the transaction with `requiresNew`, so the pool needs at least 2 connections.
- It fails closed: if the client never runs `fn`, or the transaction does not end in the rollback
  it asked for, it throws a `KneadError` (`withRollback: rollback not confirmed`) instead of
  resolving.

> [!CAUTION]
> `withRollback()` does not cover requests sent to a real server (`createApp()` and `request()`, or
> `listen()` and `fetch`). Those requests run in their own async context, never see the test's
> transaction, and commit for real. Clean up after such tests yourself, or test through services
> inside `withRollback()`.

Point these tests at a disposable database through a variable of their own, never at
`DATABASE_URL`, so a misconfigured environment cannot touch real data. This repository's own
Postgres suite does the same with `KNEAD_PRISMA_TEST_DATABASE_URL`:

```bash
docker run -d --rm --name knead-prisma-pg -p 5433:5432 -e POSTGRES_PASSWORD=knead postgres:17-alpine
KNEAD_PRISMA_TEST_DATABASE_URL=postgresql://postgres:knead@localhost:5433/postgres pnpm --filter @knead-js/prisma test:db
```

`test:db` exits with an error when the variable is unset, then runs `prisma generate` and
`prisma db push --force-reset` against that database, which erases it, before running the suite.
