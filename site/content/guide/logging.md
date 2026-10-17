---
title: Logging
description: Log through the injected LOGGER, rely on built-in credential redaction, and switch to JSON structured output with LoggingModule.
---

Every Knead application has one logger, provided under the `LOGGER` token from `@knead-js/core`.
The framework writes to it (the listening address, unhandled request errors, WebSocket and
GraphQL problems) and so do your providers. Out of the box it is a `ConsoleLogger`; importing
`LoggingModule.forRoot()` from `@knead-js/logging` replaces it everywhere with a `JsonLogger`
that writes one JSON object per line. Whatever logger is configured, credentials are redacted
before they are written.

## Log from a provider

Inject `LOGGER` and call one of its four methods, `debug`, `info`, `warn` or `error`. Each takes
a message and any number of extra values (meta):

<<< logging/orders.service.ts title="orders.service.ts"

`LOGGER` is typed with the `Logger` interface, so code that logs does not depend on which logger
is configured. Keep the message a fixed string and put the variable parts in meta objects: a
structured logger turns them into separate fields that you can search and aggregate.

Do not call `console.*` directly. Those calls bypass the configured logger, its redaction and
its JSON format, and tests cannot capture them.

## The default logger

Without `LoggingModule`, `LOGGER` is a `ConsoleLogger`, one instance shared by every module. It
writes through `console.debug`, `console.info`, `console.warn` and `console.error`, prefixing the
message with `[knead]`:

```text
[knead] connected to redis://***@cache:6379\nforged {
  password: "***",
  user: "ada",
}
```

That line came from
`info('connected to redis://app:hunter2@cache:6379\nforged', { password: 'hunter2', user: 'ada' })`.
The `ConsoleLogger` redacts credentials in the message and in every meta value, and escapes
control characters (CR, LF, ESC and the rest of U+0000 to U+001F, plus DEL) in the message and in
string meta, so a logged value cannot start a forged line. The originals are never modified, and
a failing console never throws into your code. Pass another prefix to the constructor:
`new ConsoleLogger('orders')` writes `[orders] ready`.

## JSON logs with `LoggingModule`

For production, where logs are collected and parsed, import `LoggingModule.forRoot()` once, in
the root module:

<<< logging/app.module.ts title="app.module.ts"

```bash
bun add @knead-js/logging
```

`LoggingModule` is global and makes a `JsonLogger` the `LOGGER` of every module, including the
framework's own. The `OrdersService` above then writes:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"orders-api","msg":"order placed","service":"orders","orderId":"ord_1042","totalCents":4999}
```

Every record is one line: `time` (ISO 8601), `level`, `logger` (the `name` option) and `msg`
come first, then the logger's `fields`, then the entry's meta. Debug and info lines go to stdout,
warn and error lines to stderr.

Import `forRoot()` exactly once. Importing the bare `LoggingModule` fails startup with
`LoggingConfigError: Import LoggingModule.forRoot(), not LoggingModule`, and importing two
separate `forRoot()` results fails with
`LoggingModule.forRoot() is imported 2 times; import it once, in the root module`, because
modules would disagree on which logger they see. The same `forRoot()` value imported from two
places counts once.

### How meta becomes fields

`JsonLogger` sorts each meta argument by what it is:

- A plain object is merged into the record as fields. When two objects set the same key, the
  later one wins.
- The first `Error` becomes the `err` field.
- Anything else (strings, numbers, arrays, later errors) is collected, in order, in a `meta`
  array.

So `warn('retrying', { attempt: 2 }, new Error('timeout'), 'upstream', 7, { attempt: 3 }, new Error('second'))`
outside development writes:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"warn","logger":"knead","msg":"retrying","attempt":3,"err":"Error: timeout","meta":["upstream",7,"Error: second"]}
```

Fields and meta can never set `time`, `level`, `logger`, `msg`, `err` or `meta`: those keys are
dropped from them. `__proto__`, `constructor` and `prototype` keys are dropped everywhere, so a
record parsed downstream cannot pollute a prototype.

Values are converted to plain JSON data on the way:

| Value | Written as |
| --- | --- |
| `bigint` | A string: `10n` is `"10"`. |
| `undefined`, functions, symbols | Left out (inside an array, `null`). |
| `Date` and objects with `toJSON()` | Their `toJSON()` result. |
| Class instances | Their own enumerable properties: `new Point(1, 2)` is `{"x":1,"y":2}`. |
| `Map`, `Headers` | An object of their entries, keys redacted. |
| `Set` | An array. |
| Typed arrays, `ArrayBuffer` | `"[Uint8Array 16 bytes]"`. |
| A value already on the current path | `"[Circular]"`. |
| A value that throws when read | `"[unreadable]"`. |
| An `Error` anywhere | A string, as described in [errors in logs](#errors-in-logs). |

## Child loggers

To add the same fields to every entry of a component, wrap the injected logger with
`childLogger()`:

<<< logging/child.ts title="invoice.job.ts"

With a `JsonLogger` named `billing`, `run('b_17', 120)` writes:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch started","component":"invoices","batchId":"b_17","invoices":120}
{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch finished","component":"invoices","batchId":"b_17"}
```

`childLogger(logger, fields)` works with any `Logger`, which is why it is the call to use in
providers. On a `JsonLogger` it returns `logger.child(fields)`: the same level, name, sink and
development flag, with `fields` added to (or replacing) the parent's fields. On any other logger
(a `ConsoleLogger`, or the `MemoryLogger` of a test) it passes the fields as the first meta
argument of every call, merging the fields of nested children, so tests see them too. Child fields
are redacted once, when the child is created, and cannot set the reserved keys.

## Redaction

Knead redacts credentials before anything reaches a log, whatever logger is configured: the
`ConsoleLogger` and `JsonLogger` redact everything they write, and the framework's own error
logging redacts the message and error before it calls `LOGGER`, so even a custom logger receives
redacted data. Both rules come from `@knead-js/core` and are exported, so a custom logger can
apply them too.

### Credentials in text

`redactCredentials(text)` replaces four kinds of credential with `***`:

- **URL userinfo**: `redis://app:hunter2@cache:6379` becomes `redis://***@cache:6379`, for any
  scheme. The userinfo runs to the last `@` within the first 1024 characters of the URL, because
  passwords often contain an unencoded `@` or `/` (`postgres://app:p@ss/w0rd@db/shop` becomes
  `postgres://***@db/shop`). An `http(s)` URL that starts `host[:port]/` keeps an `@` in its path
  (`https://example.com/users/@ada` is unchanged), but credential URLs nested in it are still
  redacted. The scheme starts at its first letter, so `-redis://u:p@h` is redacted too.
- **Secret `key=value` pairs**: the value of any pair whose key is sensitive, with the same rules
  as [sensitive keys in objects](#sensitive-keys-in-objects) (`client_secret`, `x-api-key`,
  `SharedAccessKey`, `sig`, ...). An unquoted value ends at `&`, `;` or whitespace, so
  `/callback?code=1&client_secret=abc&state=2` becomes `/callback?code=1&client_secret=***&state=2`
  and `DB_PASSWORD=hunter2` becomes `DB_PASSWORD=***`; a quoted one runs to its closing quote
  (`password="hunter 2"` becomes `password="***"`).
- **Secret `key: value` pairs**: JSON (`{"password":"x"}` becomes `{"password":"***"}`), YAML and
  inspected objects. A `key:` with an unquoted key counts only at the start of a line or after `{`
  or `,`, so "Invalid token: expired" stays readable. An `Authorization:` or `Cookie:` line loses
  its whole value whatever its shape (`Cookie: ***`, `Authorization: Token ***`).
- **`Bearer` and `Basic` credentials**, in any case: `Bearer eyJhbGciOi.payload.sig` becomes
  `Bearer ***`. Only credential-shaped values are replaced (8 or more token characters, or a `:`
  or `=` between token characters), so prose such as "a basic mistake" stays readable.

> [!WARNING]
> Some credentials are not recognized: short bearer tokens such as `Bearer abc123`, passwords
> containing spaces or quotes in a URL (they cannot appear unencoded in a valid URL), userinfo
> longer than 1024 characters, and any secret that has no recognizable shape or key name. Keep
> secrets out of log messages in the first place.

### Sensitive keys in objects

`redactValue(value)` returns a redacted copy of objects, arrays and errors, walking up to 4
levels deep:

- Every string is passed through `redactCredentials()`, keys included.
- The value of a sensitive key becomes `***`, whatever the value. The exact keys are
  `authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `pwd`, `secret`, `token`,
  `apikey`, `api_key`, `accesstoken`, `refreshtoken`, `accountkey`, `privatekey` and
  `connectionstring`, in any case, and `pass`, `passphrase`, `jwt`, `sig`, `accesskey` and
  `sharedaccesskey` once lowercased and stripped of `-` and `_`.
- A key that contains one of the words `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`,
  `accountkey`, `privatekey`, `connectionstring`, `authorization`, `cookie`, `credential` or
  `sessionid`, once lowercased and stripped of `-` and `_`, is sensitive too (`db_password`,
  `x-api-key`, `clientSecret`, `AWS_SECRET_ACCESS_KEY`, `sessionId`). For these keys, numbers and
  booleans are kept, so `maxTokens: 100` stays readable, while `token: 42` (an exact key) becomes
  `***`.
- A `URL` is walked as its `href`, a `Request` or `Response` as its method or status, URL and
  headers, and `Headers`, `Map` and other objects with `entries()` or `toJSON()` as their entries.
- Other class instances are walked as their own properties, into a copy with the same prototype.
  Dates and binary data are kept as they are.
- Cycles become `[Circular]`, and objects deeper than 4 levels become `[Object]` (or `[Array]`).
  At most 20000 strings and objects are walked per value; the rest become `[Truncated]`.

The original value is never modified, and a value with nothing to redact is returned as is.

### Escaping

`JsonLogger` relies on JSON escaping: newlines and other control characters inside strings are
escaped by `JSON.stringify`, and so are U+2028 and U+2029 (which `JSON.stringify` leaves alone but
some log readers treat as line breaks). Every record stays on one line, so a logged value cannot
forge another record. For interpolating a client-controlled value into a message with any logger,
`logValue(value)` from `@knead-js/core` caps it at 1024 characters and escapes control
characters.

## Errors in logs

An error's stack, cause chain and properties often carry request data: SQL with parameters, URLs
with tokens, response bodies. `JsonLogger` therefore writes errors in full only in development:

- **Outside development**, an error is written as `Name: message` only (core's
  `summarizeError()`): the message is redacted, capped at 500 characters and control characters
  are escaped. No stack, cause or properties.
- **In development**, an error is written as its redacted stack, then its own enumerable
  properties as redacted JSON on an indented line, then each cause as `Caused by: ...`, up to 16
  errors (a longer chain ends with `Caused by: … (more causes omitted)`). `AggregateError` errors
  are included as an `errors` property.

For an error with a `code` and a `password` property and a cause, a `JsonLogger` writes
outside development:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"error","logger":"knead","msg":"query failed","err":"Error: query failed for postgres://***@db/shop"}
```

and in development, `err` holds (shown here with its newlines expanded):

```text
Error: query failed for postgres://***@db/shop
    at run (db.ts:10:5)
  {"code":"ECONNRESET","password":"***"}
Caused by: Error: connection reset
    at socket (net.ts:3:1)
```

"Development" is the application's development flag: `KneadFactory.create(root, { development })`,
which defaults to `NODE_ENV === 'development'`. `LoggingModule` passes that flag to its
`JsonLogger` unless you set the `development` option yourself.

Pass errors to the logger as meta rather than building messages from them
(`` `failed: ${error}` ``). The logger can then apply the rules above; a message string is only
redacted, never shortened.

> [!IMPORTANT]
> The `ConsoleLogger` does not make this distinction: it prints an error you pass with its stack,
> cause and properties (redacted) in every environment. Outside development, never pass a raw
> error to a logger that is not a `JsonLogger`. Pass `summarizeError(error)` from
> `@knead-js/core` instead, or log through `ErrorLog`, described below, which decides for you.

### Framework error lines

For a route that throws, the HTTP pipeline logs the error under a fresh correlation id, which it
also returns in the 500 response. With `LoggingModule` outside development the line is:

```json
{"time":"2026-10-17T09:30:00.000Z","level":"error","logger":"knead","msg":"Unhandled error on GET /reports (correlation id 0f5e9c1a-8f0b-4b8e-9f43-2d7e6c1b5a90): Error: replica postgres://***@db/shop is down"}
```

In development the message ends at the correlation id and the error follows as an `Error`, so it
becomes `err` with its full stack and causes. When the error held a credential, the pipeline
passes a copy whose message and stack are already redacted, so the line has the same shape: for
the route above, `err` starts with `Error: replica postgres://***@db/shop is down`, followed by
the stack, and the password appears nowhere in the line.

To log your own errors this way (with a correlation id, full in development and summarized
otherwise), use the `ErrorLog` provider or `logError()` from `@knead-js/http`; see the
[HTTP reference](/packages/http/).

## Levels

The four levels, from lowest to highest, are `debug`, `info`, `warn` and `error`. A `JsonLogger`
writes entries at or above its `level` option, which defaults to `debug` in development and
`info` otherwise. The `ConsoleLogger` writes every level and leaves filtering to the console.

## Where the logger comes from

One `LOGGER` is chosen for the whole application, by these rules from highest to lowest
precedence:

1. An `overrides` entry for `LOGGER` passed to `KneadFactory.create()`.
2. The `logger` option of `KneadFactory.create()`, which replaces every module's `LOGGER`,
   global and module-local providers alike.
3. A `LOGGER` exported by a global module, such as `LoggingModule.forRoot()`, used by every
   module (a module that registers its own `LOGGER` provider keeps that one for its own
   providers).
4. The default `ConsoleLogger`.

The `logger` option is the way to pick a logger in the bootstrap code:

<<< logging/factory.ts title="main.ts"

Any global module can provide the logger, for example a `ConsoleLogger` with another prefix:

<<< logging/console-logger.ts title="logger.module.ts"

`app.logger` on the created application is the chosen logger. [`@knead-js/testing`](/guide/testing/)
uses rule 2: `compile()` passes a `MemoryLogger` as the `logger` option, so a test captures every
log entry even when the application imports `LoggingModule`. See
[testing logs](/guide/testing/).

## Custom sinks and standalone use

The `write` option replaces stdout and stderr. It receives each record as one line of JSON
without the trailing newline, and its level:

<<< logging/sink.ts title="logging.ts"

A `write` that throws, or returns a promise that rejects, is ignored: a lost log line never fails
the code that logged it. The default sink also ignores stream errors such as `EPIPE` (the reading
end of a pipe closed) by adding a no-op `'error'` listener to stdout and stderr on first use.

`JsonLogger` does not need a module. A script or worker outside a Knead application can create
one directly:

<<< logging/standalone.ts title="reindex.ts"

All options are listed on the [`@knead-js/logging` reference page](/packages/logging/).
