---
title: @knead-js/logging
description: API reference for LoggingModule and JsonLogger, which write redacted JSON structured logs, one record per line.
---

```bash
bun add @knead-js/core @knead-js/logging
```

`@knead-js/core` is a peer dependency.

`LoggingModule.forRoot()` makes a `JsonLogger` the application's `LOGGER` in every module, so the
framework and your providers all write NDJSON (one JSON object per line) to stdout and stderr,
redacted with `@knead-js/core`'s rules. The [logging guide](/guide/logging/) covers the `LOGGER`
token, the default `ConsoleLogger`, redaction and logger precedence in depth.

## `LoggingModule`

### `LoggingModule.forRoot()`

```text
LoggingModule.forRoot(options?: JsonLoggerOptions): DynamicModule
```

Returns a global module that provides and exports `LOGGER` as
`new JsonLogger({ ...options, development: options.development ?? inject(DEVELOPMENT) })`, so
`development` defaults to the application's development flag (`KneadFactory.create()`'s
`development` option, itself defaulting to `NODE_ENV === 'development'`).

- Invalid options throw `LoggingConfigError` from `forRoot()` itself, while the module tree is
  being declared.
- Importing `LoggingModule` without `forRoot()` fails startup with
  `LoggingConfigError: Import LoggingModule.forRoot(), not LoggingModule`.
- Importing two different `forRoot()` results fails startup with
  `LoggingModule.forRoot() is imported <n> times; import it once, in the root module`. Importing
  the same result from several modules is one import.
- `JsonLogger` is not registered as a token: inject `LOGGER`, so code keeps working when the
  logger is replaced (the `KneadFactory` `logger` option, `@knead-js/testing`).

## `JsonLogger`

```text
class JsonLogger implements Logger {
  constructor(options?: JsonLoggerOptions);
  child(fields: Readonly<Record<string, unknown>>): JsonLogger;
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}
```

Writes each entry as one line of JSON. It implements core's `Logger`, so it also works on its own,
outside any module. The constructor validates its options (see
[`validateJsonLoggerOptions()`](#validatejsonloggeroptions)). Logging never throws.

### `JsonLoggerOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `level` | `LogLevel` | `'debug'` when `development` is true, otherwise `'info'` | The lowest level written. |
| `name` | `string` | `'knead'` | The `logger` field of every record. Must be non-empty. |
| `fields` | `Readonly<Record<string, unknown>>` | `{}` | Fields added to every record. Must be a plain object without `toJSON`. Redacted once, when the logger is created. |
| `development` | `boolean` | `NODE_ENV === 'development'` for `new JsonLogger()`; the application's development flag under `LoggingModule.forRoot()` | Whether errors are written in full (redacted stack, own properties and causes) rather than as `Name: message`. |
| `write` | `(line: string, level: LogLevel) => unknown` | stdout for `debug` and `info`, stderr for `warn` and `error` | Receives each record as one line of JSON without the trailing newline. A throw or a rejected promise is ignored. |
| `now` | `() => Date` | `() => new Date()` | The clock for the `time` field. |

The default sink appends `\n` to each line, and on first use adds a no-op `'error'` listener to
`process.stdout` and `process.stderr`, so a write error such as `EPIPE` never crashes the
process.

### Record shape

```json
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"orders-api","msg":"order placed","service":"orders","orderId":"ord_1042","totalCents":4999}
```

Keys appear in this order:

| Key | Content |
| --- | --- |
| `time` | `now().toISOString()`. |
| `level` | `'debug'`, `'info'`, `'warn'` or `'error'`. |
| `logger` | The `name` option. |
| `msg` | The message, redacted with `redactCredentials()`. |
| logger fields | The `fields` option, then fields added by `child()`. |
| meta fields | The keys of every plain-object meta argument, later arguments winning. |
| `err` | The first `Error` meta argument, as a string. |
| `meta` | Every other meta argument, in order. Present only when there is one. |

Fields and meta never set `time`, `level`, `logger`, `msg`, `err` or `meta`, and `__proto__`,
`constructor` and `prototype` keys are dropped at every depth.

### Serialization

Every value is copied into plain JSON data and redacted: strings and object keys with
`redactCredentials()`, objects with `redactValue()` (the values of sensitive keys such as
`authorization` and `password` become `***`). The full rules are in the
[logging guide](/guide/logging/).

| Value | Written as |
| --- | --- |
| `bigint` | Its decimal string. |
| `undefined`, function, symbol | Omitted from objects; `null` in arrays. |
| Object with `toJSON()` (such as `Date`) | Its `toJSON()` result, copied the same way. |
| Class instance | Its own enumerable properties. |
| `Map`, `Headers` | An object of their entries. |
| `Set` | An array. |
| Typed array, `ArrayBuffer` | `"[<constructor name> <n> bytes]"`. |
| Cycle | `"[Circular]"`. |
| Throwing getter or `toJSON()` | `"[unreadable]"`. |
| `Error` (anywhere) | Outside development, `summarizeError()`: `Name: message`, redacted, at most 500 characters, control characters escaped. In development, its redacted stack (or `Name: message` when the stack does not contain the message), an indented line with its own enumerable properties as redacted JSON (with `errors` for an `AggregateError`), then `Caused by: ...` with the same details for each cause (a cause that is not an `Error` is written as redacted JSON), up to 16 errors, after which the text ends with `Caused by: … (more causes omitted)`. |

Output is escaped by `JSON.stringify`, plus U+2028 and U+2029, so a record is always exactly one
line.

### Limits

These caps keep the work linear in the size of the input, whatever is logged:

| Limit | Value | Result when exceeded |
| --- | --- | --- |
| Depth | 4 levels below each meta argument | `"[Object]"` or `"[Array]"` |
| Items per array or `Set` | 1000 | A final `"[<n> more items]"` item |
| Entries per `Map` or `Headers` | 1000 | A `"…": "more entries omitted"` entry |
| Keys per object | 1000 | A `"…": "<n> more keys omitted"` entry |
| Values per record | 10000 | `"[Truncated]"` |
| Errors per cause chain (development) | 16 | `Caused by: … (more causes omitted)` |

If the clock or the message itself cannot be read, the logger still writes a record, with
`"meta":"[unloggable meta]"` (and `"msg":"[unloggable message]"` when the message could not be
converted to a string).

### `child()`

`logger.child(fields)` returns a `JsonLogger` with the same level, name, sink, clock and
development flag, whose fields are this logger's fields plus `fields` (a key in `fields` replaces
the parent's). The parent is unchanged. `fields` must be a plain object without `toJSON`,
otherwise `LoggingConfigError: JsonLogger child() fields must be a plain object without toJSON`.

## `childLogger()`

```text
childLogger(logger: Logger, fields: Readonly<Record<string, unknown>>): Logger
```

Adds `fields` to every entry of any `Logger`. For a `JsonLogger` it returns `logger.child(fields)`.
For any other logger it returns a wrapper that passes the fields as the first meta argument of
every call; wrapping a wrapper merges the fields into one object (later fields win). Throws
`LoggingConfigError: childLogger() fields must be a plain object without toJSON` for other values.
Use it as `childLogger(inject(LOGGER), { component: 'invoices' })`.

## `validateJsonLoggerOptions()`

```text
validateJsonLoggerOptions(options: JsonLoggerOptions): void
```

Throws `LoggingConfigError` for the first invalid option. `JsonLogger` and
`LoggingModule.forRoot()` call it. The messages:

| Problem | Message |
| --- | --- |
| Unknown `level` | `JsonLogger level must be one of debug, info, warn, error, got <value>` |
| Empty or non-string `name` | `JsonLogger name must be a non-empty string` |
| `fields` not a plain object, or with `toJSON` | `JsonLogger fields must be a plain object without toJSON` |
| `write` not a function | `JsonLogger write must be a function` |
| `now` not a function | `JsonLogger now must be a function` |

## `LoggingConfigError`

Extends core's `KneadError`. Thrown for invalid options, a bare `LoggingModule` import, a repeated
`forRoot()` import and invalid child fields.

## Related core APIs

These live in `@knead-js/core` (and are re-exported by `@knead-js/http`); they are documented on
the [core reference page](/packages/core/):

- `LOGGER`, the injection token, and `Logger`, the interface with `debug`, `info`, `warn` and
  `error`, each `(message: string, ...meta: unknown[]) => void`.
- `LogLevel`: `'debug' | 'info' | 'warn' | 'error'`.
- `ConsoleLogger` (the default) and `MemoryLogger` (tests only: it keeps entries unredacted).
- `redactCredentials()`, `redactValue()`, `summarizeError()`, `logValue()` and `logError()`.

## Logger precedence

With `KneadFactory.create()`, from highest to lowest: an `overrides` entry for `LOGGER`, the
`logger` option (which replaces every module's `LOGGER` provider), the `LOGGER` of a global module
such as `LoggingModule.forRoot()`, and the default `ConsoleLogger`. `@knead-js/testing` passes a
`MemoryLogger` as the `logger` option, so tests capture logs even when the application imports
`LoggingModule`. `ApplicationContext.create()` from core treats its own `logger` option
differently: there it is only the default, used unless a global module provides `LOGGER`.
