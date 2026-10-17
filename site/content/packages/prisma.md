---
title: @knead-js/prisma
description: API reference for @knead-js/prisma, the Prisma 7 integration with a managed client, ambient transactions, HTTP error mapping and rollback-only tests.
---

```bash
bun add @knead-js/core @knead-js/prisma @prisma/client @prisma/adapter-pg pg
bun add -d prisma
```

Prisma 7 needs a driver adapter; the command installs the Postgres one (`@prisma/adapter-pg` with
`pg`). Use the adapter for your database instead if it is not Postgres. Peer dependencies:
`@knead-js/core` (required), `@prisma/client` `^7` (optional to the package manager, but you need
it to have a client) and `@knead-js/http` (optional, needed only for `@knead-js/prisma/http`).
The package requires Bun 1.4.3 or later and has no runtime dependencies. It never imports
`@prisma/client`, not even its types: you register your generated client's type once (see
[`PrismaClientRegistry`](#prismaclientregistry)).

It has three entry points:

| Import | Contents |
| --- | --- |
| `@knead-js/prisma` | `PrismaModule`, `PrismaService`, `TransactionHost`, `@Transactional()`, tokens and types. |
| `@knead-js/prisma/http` | `PrismaHttpModule` and helpers that answer Prisma errors with problem responses. |
| `@knead-js/prisma/testing` | `withRollback()`. |

The [database guide](/guide/database/) walks through setup, repositories, transactions, error
mapping and testing with complete examples.

## `PrismaModule`

A global module that provides and exports `PrismaService`, `TransactionHost` and `PRISMA_CLIENT`.

### `PrismaModule.forRoot()`

`PrismaModule.forRoot(options: PrismaModuleOptions): DynamicModule`. The options are validated
when it is called; a problem throws `KneadError`.

### `PrismaModule.forRootAsync()`

`PrismaModule.forRootAsync(options: PrismaModuleAsyncOptions): DynamicModule` resolves the options
at bootstrap and validates them then.

### `PrismaModuleAsyncOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `imports` | `ModuleImport[]` | `[]` | Modules whose exports `useFactory` can `inject()`. |
| `useFactory` | `() => PrismaModuleOptions \| Promise<PrismaModuleOptions>` | required | Runs in an injection context at bootstrap. |

### `PrismaModuleOptions`

A union of two shapes; give exactly one of `client` and `instance`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `() => RegisteredClient \| Promise<RegisteredClient>` | | A factory. The module owns the client: it connects it at bootstrap and disconnects it at shutdown. |
| `instance` | `RegisteredClient` | | A client you built and own. It is connected at bootstrap. |
| `disconnectOnShutdown` | `boolean` | `false` | With `instance` only: also disconnect it at shutdown. |

Validation, with the `KneadError` messages:

- neither or both of `client` and `instance`:
  `PrismaModule options need exactly one of \`client\` or \`instance\`.`
- `client` that is not a function:
  `PrismaModule \`client\` must be a function returning a Prisma client.`
- an `instance`, or the value the factory returns, without `$connect`, `$disconnect` or
  `$transaction` methods: `PrismaModule client must be a Prisma client with a $connect() method.`
  (naming the first missing method).
- a `disconnectOnShutdown` that is not a boolean:
  `PrismaModule \`disconnectOnShutdown\` must be a boolean.`

## `PrismaService`

An injectable service, built by the module.

| Member | Type | Description |
| --- | --- | --- |
| `client` | `RegisteredClient` | The base client. Queries through it never join the ambient transaction. |
| `db` | `TxClient` | The active transaction's client in the current async context, or `client` when there is none. Query through this. |

Lifecycle:

- `onModuleInit` calls `client.$connect()`. If it fails, a client built by a `client` factory is
  disconnected (best effort), and bootstrap fails with a `KneadError` whose message is
  `Prisma failed to connect to the database` and whose `cause` is the original error. The failure
  is logged through `LOGGER`: outside development as `Prisma failed to connect: <name> (<code>)`,
  with only the error's name and its `code` or `errorCode` (each only when it looks like an
  identifier), never the message; in development as the full error with credentials redacted.
- `onModuleDestroy` calls `client.$disconnect()` when the module built the client, or when
  `disconnectOnShutdown` is `true`.

## Transactions

### `TransactionHost`

Runs work inside an ambient Prisma interactive transaction. There is one per application, built by
the module. The transaction is carried in an `AsyncLocalStorage` owned by the host, so separate
applications in one process never share transactions.

`run<R>(fn: () => Promise<R>, options?: RunOptions): Promise<R>`

- Without an active transaction, or with `propagation: 'requiresNew'`, it calls
  `$transaction(callback, { isolationLevel, timeout, maxWait })` on the client (only the options
  that are set) and runs `fn` inside. The transaction commits when `fn` resolves; when `fn`
  rejects, it rolls back and `run()` rejects with the same value.
- With an active transaction and `propagation: 'required'` (the default), `fn` joins it and the
  options are ignored. In development, joining with options that differ from the active ones logs
  `TransactionHost: joined an active transaction with different options; the inner options are ignored`
  as a warning through `LOGGER`.
- A joined `fn` that rejects marks the transaction rollback-only. If the owning `fn` resolves
  anyway, the transaction rolls back and the owning `run()` rejects with a `KneadError`
  (`TransactionHost: transaction marked rollback-only by an inner failure`) whose `cause` is the
  first inner rejection. If the owner rejects itself, its own rejection wins.
- An unknown `propagation` rejects with a `KneadError`.

`isActive: boolean` is `true` when the current async context is inside an open transaction.

### `@Transactional()`

`Transactional(options?: RunOptions)` decorates an async instance method so that each call runs
through `TransactionHost.run(() => method(...args), options)`.

- The method must return a `Promise`; anything else is a type error.
- The class must be built by the DI container. The decorator takes `TransactionHost` with
  `inject()` during construction, so `new` throws `InjectionContextError`.
- A static method, or a `propagation` or `isolationLevel` outside the allowed values, throws
  `KneadError` when the class is defined.
- If the instance has no `TransactionHost` (Bun older than 1.4.3 can skip the decorator's
  initializer, or an object created without the container), calling the method rejects with a
  `KneadError` naming both causes, instead of running without a transaction.

### `RunOptions`

Extends `TransactionOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `propagation` | `Propagation` | `'required'` | Whether to join the active transaction or open a separate one. |
| `isolationLevel` | `IsolationLevel` | the database default | Passed to `$transaction()`. |
| `timeout` | `number` | Prisma's default (5000 ms) | Milliseconds the transaction may run. |
| `maxWait` | `number` | Prisma's default | Milliseconds to wait for a connection. |

### `Propagation`

`type Propagation = 'required' | 'requiresNew'`. `'required'` joins the active transaction.
`'requiresNew'` always opens a separate transaction on another connection: it needs a pool of at
least 2 connections, and it can deadlock against the outer transaction when both touch the same
rows.

### `TransactionOptions`

The options Prisma's `$transaction()` takes: `isolationLevel?: IsolationLevel`,
`timeout?: number` (milliseconds the transaction may run) and `maxWait?: number` (milliseconds to
wait for a connection).

### `IsolationLevel`

`type IsolationLevel = 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable' | 'Snapshot'`.
Which levels a database supports is up to the database and its adapter.

## Tokens

### `PRISMA_CLIENT`

`InjectionToken<RegisteredClient>`, the client `PrismaService` and `TransactionHost` use. Override
it in tests to replace the client everywhere at once:
`Test.createModule(...).overrideProvider(PRISMA_CLIENT).useValue(fake)`.

### `PRISMA_OPTIONS`

`InjectionToken<PrismaModuleOptions>`, the module options. Not exported from the module; provided
for code inside it.

## Client types

### `PrismaClientRegistry`

An empty interface you extend by declaration merging to register your generated client:
declare `client: PrismaClient` inside `interface PrismaClientRegistry` in a
`declare module '@knead-js/prisma'` block. The [database guide](/guide/database/) shows the file.
Register the client in one place only.

### `RegisteredClient`

The registered `client` type, or `PrismaLike` when nothing is registered.

### `TxClient`

`Omit<RegisteredClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>`: the
type of `PrismaService.db`, matching what Prisma passes to an interactive transaction.

### `PrismaLike`

The structural minimum the package relies on: `$connect(): Promise<void>`,
`$disconnect(): Promise<void>` and
`$transaction<R>(fn: (tx: any) => Promise<R>, options?: TransactionOptions): Promise<R>`. Used
when no client is registered.

## `@knead-js/prisma/http`

### `PrismaHttpModule`

`PrismaHttpModule.forRoot(options?: PrismaHttpOptions): DynamicModule` registers
`PrismaExceptionFilter` as an `APP_FILTER`. Import it once, in the root module: importing
`forRoot()` more than once fails at startup with `KneadError: PrismaHttpModule.forRoot() is
imported <n> times; import it once, in the root module`, and importing `PrismaHttpModule` itself
without `forRoot()` fails with `Import PrismaHttpModule.forRoot(), not PrismaHttpModule`.

### `PrismaHttpOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `map` | `Record<string, PrismaErrorMapper>` | none | Overrides and additions keyed by error code (`'P2034'`) or error name. Must be a plain object (or one with a `null` prototype) whose own values, including symbol and non-enumerable keys, are all functions; otherwise `forRoot()` throws `KneadError`. A frozen copy is stored. |

### `PrismaExceptionFilter`

The filter the module registers. For a Prisma error it builds the exception with
`toHttpException()` and answers with the same problem response the default error handling gives
that `HttpException`: masked 5xx details outside development and, for a 5xx, a logged
`correlationId`. For any
other error it returns `undefined`, so later filters and the default handling still apply.

### `toHttpException()`

`toHttpException(error: unknown, options?: { map?: Record<string, PrismaErrorMapper>; development?: boolean }): HttpException | undefined`

Returns `undefined` when `isPrismaError(error)` is false. Otherwise a mapper from `map` (looked up
as an own key, by `code` and then by `name`) wins; a mapper that throws or returns a value that is
not an `HttpException` yields an `InternalServerErrorException` with no detail. Without a mapper:

| Prisma error | Exception | Status | `detail` |
| --- | --- | --- | --- |
| code `P2002` | `ConflictException` | 409 | `A record with these values already exists.` |
| code `P2003` | `ConflictException` | 409 | `The operation conflicts with a related record.` |
| code `P2025` | `NotFoundException` | 404 | `The requested record was not found.` |
| code `P2000` | `BadRequestException` | 400 | `A value is too long for its field.` |
| code `P1001`, `P1002` or `P2024` | `ServiceUnavailableException` | 503 | `The database is temporarily unavailable.` |
| name `PrismaClientValidationError` | `BadRequestException` | 400 | `The request could not be processed.` |
| name `PrismaClientInitializationError` | `ServiceUnavailableException` | 503 | `The database is temporarily unavailable.` |
| anything else | `InternalServerErrorException` | 500 | none |

The original error is the exception's `cause`; its message is never used. With
`development: true` the built-in mappings add the extensions `prismaCode` (the error's `code`) and,
when the metadata names the constraint's fields as an array of strings, `fields`. Those are read
from `meta.driverAdapterError.cause.constraint.fields` (Prisma 7 driver adapters) or else
`meta.target`. `@prisma/adapter-pg` 7.10 and later name a violated unique index
(`constraint.index`) instead of its fields, so a Postgres unique violation has no `fields`.

### `isPrismaError()`

`isPrismaError(e: unknown): e is PrismaErrorLike` is true for an object whose `name` is exactly
`PrismaClientKnownRequestError`, `PrismaClientValidationError`,
`PrismaClientInitializationError`, `PrismaClientRustPanicError` or
`PrismaClientUnknownRequestError`. It does not use `instanceof`, so errors from another copy or
realm of the client match.

### `PrismaErrorLike`

The structural shape of a Prisma error: `name: string`, `code?: string` and
`meta?: Record<string, unknown>`.

### `PrismaErrorMapper`

`type PrismaErrorMapper = (error: PrismaErrorLike) => HttpException`.

## `@knead-js/prisma/testing`

### `withRollback()`

`withRollback<R>(ctx: { get<T>(token: Token<T>): T }, fn: () => Promise<R>, options?: { timeout?: number }): Promise<R>`

Runs `fn` through `TransactionHost.run()` with `propagation: 'requiresNew'` and
`timeout: options.timeout ?? 30_000`, then forces a rollback, and resolves with `fn`'s value.
`ctx` is a `TestingModule`, an `ApplicationContext` or anything else with `get(token)`. Errors
thrown by `fn` propagate unchanged. If the client never ran `fn`, or the transaction did not end
with the rollback it asked for, it throws a `KneadError` (`withRollback: rollback not confirmed`).

Requests to a real test server run in their own async context, outside the rolled-back
transaction, and commit.
