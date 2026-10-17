# @knead-js/logging

[![npm](https://img.shields.io/npm/v/@knead-js/logging?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/logging)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

JSON structured logging for Knead: `LoggingModule.forRoot()` makes a `JsonLogger` the `LOGGER` of
every module, so the framework and your providers write one redacted JSON record per line (NDJSON)
for your log pipeline.

**[Documentation](https://quinnjr.github.io/knead/packages/logging/)** · [Guide](https://quinnjr.github.io/knead/guide/logging/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core @knead-js/logging
```

Requires Bun 1.4.3 or newer. `@knead-js/core` is a peer dependency.

## Quick start

Import `LoggingModule.forRoot()` once, in the root module:

```ts
import { Module } from '@knead-js/core';
import { LoggingModule } from '@knead-js/logging';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    LoggingModule.forRoot({
      name: 'orders-api',
      fields: { service: 'orders' },
    }),
  ],
  providers: [OrdersService],
})
export class AppModule {}
```

Providers keep logging through the injected `LOGGER`:

```ts
import { inject, LOGGER } from '@knead-js/core';

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
}

export class PaymentDeclinedError extends Error {
  override name = 'PaymentDeclinedError';
}

export class OrdersService {
  readonly #log = inject(LOGGER);

  place(order: Order): void {
    this.#log.info('order placed', { orderId: order.id, totalCents: order.totalCents });
  }

  charge(order: Order, error: unknown): void {
    // Pass the error itself as meta: the logger decides how much of it to write.
    this.#log.error('payment failed', error, { orderId: order.id });
  }
}
```

`place()` writes this line to stdout:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"orders-api","msg":"order placed","service":"orders","orderId":"ord_1042","totalCents":4999}
```

## Features

- **One logger everywhere.** The framework's own lines (request errors, `listen()`, WebSockets,
  GraphQL) and your providers' share one format.
- **NDJSON.** `time`, `level`, `logger` and `msg` first, then fields. Debug and info go to stdout,
  warn and error to stderr.
- **Redacted.** Credentials in strings and the values of sensitive keys are masked with
  `@knead-js/core`'s rules before anything is written.
- **Errors by environment.** Outside development an error is only `Name: message`; in development
  it is the redacted stack, properties and causes.
- **Bounded.** Depth, item and value caps keep logging linear whatever you pass it.
- **Never throws.** Unreadable values, cycles, failing sinks and broken pipes are absorbed.
- **Child loggers** that add fields to every entry, and custom sinks.

## Records

Each record starts with `time` (ISO 8601), `level`, `logger` (the `name` option) and `msg`. Then
come the logger's `fields`, its child fields and the entry's meta arguments:

- a plain object is merged in as fields (later ones win);
- the first `Error` becomes `err`;
- anything else is collected, in order, in a `meta` array.

Fields and meta never set `time`, `level`, `logger`, `msg`, `err` or `meta`, and `__proto__`,
`constructor` and `prototype` keys are dropped at every depth. JSON escaping, plus U+2028 and
U+2029, keeps every record on exactly one line, so a logged value cannot forge another record.

## Child loggers

```ts
import { inject, LOGGER } from '@knead-js/core';
import { childLogger } from '@knead-js/logging';

export class InvoiceJob {
  // Every entry from this class carries `component: 'invoices'`.
  readonly #log = childLogger(inject(LOGGER), { component: 'invoices' });

  run(batchId: string, invoices: number): void {
    const batchLog = childLogger(this.#log, { batchId });
    batchLog.info('batch started', { invoices });
    batchLog.info('batch finished');
  }
}
```

With a `JsonLogger` named `billing`, `run('b_17', 120)` writes:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch started","component":"invoices","batchId":"b_17","invoices":120}
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch finished","component":"invoices","batchId":"b_17"}
```

On a `JsonLogger`, `childLogger()` is `logger.child(fields)`. On any other logger (a
`ConsoleLogger`, or the `MemoryLogger` of `@knead-js/testing`) it passes the fields as the first
meta argument, so tests capture them too.

## Redaction and errors

- **Strings and keys**: URL userinfo (`postgres://***@db/shop`), secret `key=value` pairs and
  `Bearer`/`Basic` credentials.
- **Objects**: the values of sensitive keys (`authorization`, `cookie`, `password`, `token`,
  `apikey`, ...) become `***`, in plain objects, class instances, `Map`s and `Headers`.
- **Errors**, wherever they appear: outside development `Name: message`, redacted and capped at
  500 characters, with no stack, cause or properties. In development, the redacted stack, own
  properties and up to 16 causes. An error's properties count toward the depth limit like any
  other value, an error reached again through its own properties or causes is `"[Circular]"`,
  and after 100 detailed errors in one record the rest are written as `Name: message`.

Pass errors as meta (`log.error('payment failed', error)`) rather than interpolating them into the
message, so the logger can apply these rules.

## Limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| Depth | 4 levels below each meta argument | `"[Object]"` or `"[Array]"` |
| Items per array, `Set`, `Map` or object | 1000 | The rest is summarized as omitted |
| Values per record | 10000 | `"[Truncated]"` |
| Errors per cause chain (development) | 16 | `Caused by: … (more causes omitted)` |
| Detailed errors per record (development) | 100 | `Name: message`, as outside development |

A value that throws when read becomes `"[unreadable]"`, a cycle `"[Circular]"`. A sink that
throws or rejects is ignored, and the default sink adds a no-op `'error'` listener to stdout and
stderr on first use, so `EPIPE` never crashes the process.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `level` | `'debug'` in development, otherwise `'info'` | The lowest level written. |
| `name` | `'knead'` | The `logger` field. |
| `fields` | `{}` | A plain object added to every record. |
| `development` | the application's development flag (`NODE_ENV === 'development'` for `new JsonLogger()`) | Whether errors are written in full. |
| `write(line, level)` | stdout or stderr | A custom sink; `line` has no trailing newline. |
| `now` | `() => new Date()` | The clock for `time`. |

Invalid options are a `LoggingConfigError` from `forRoot()`. Importing `LoggingModule` without
`forRoot()`, or two different `forRoot()` results, is a `LoggingConfigError` at startup.

## Precedence

With `KneadFactory.create()`, an `overrides` entry for `LOGGER` wins, then the `logger` option,
then `LoggingModule`'s logger, then the default `ConsoleLogger`. `@knead-js/testing` passes a
`MemoryLogger` as the `logger` option, so tests capture logs even when the application imports
`LoggingModule`. Inject `LOGGER`, not `JsonLogger`, so code keeps working when the logger is
replaced. `new JsonLogger(options)` also works on its own, outside any module.

## Documentation

- [`@knead-js/logging` reference](https://quinnjr.github.io/knead/packages/logging/): record
  shape, serialization, limits and errors.
- [Logging guide](https://quinnjr.github.io/knead/guide/logging/): the `LOGGER` token, the default
  `ConsoleLogger`, redaction rules and framework error lines.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
