# @knead-js/logging

`LoggingModule.forRoot(options)`: makes a `JsonLogger` the application's `LOGGER` in every module, so the framework (request errors, `listen()`, WebSockets, GraphQL) and your providers all write one JSON object per line (NDJSON) to stdout (debug, info) and stderr (warn, error). Import it once, in the root module.

```ts
import { inject, LOGGER, Module } from '@knead-js/core';
import { childLogger, LoggingModule } from '@knead-js/logging';

@Module({ imports: [LoggingModule.forRoot({ level: 'info', fields: { service: 'api' } })] })
class AppModule {}

class ReportJob {
  readonly log = childLogger(inject(LOGGER), { job: 'report' });

  run() {
    this.log.info('report sent', { rows: 42 });
    // {"time":"2026-10-16T12:00:00.000Z","level":"info","logger":"knead","msg":"report sent","service":"api","job":"report","rows":42}
  }
}
```

Each record starts with `time` (ISO 8601), `level`, `logger` (the `name` option, default `knead`) and `msg`. Then come the logger's `fields`, its child fields, and the entry's meta: a plain-object argument is merged in as fields (later ones win), the first Error is `err`, and any other argument is collected in a `meta` array. Fields and meta never set `time`, `level`, `logger`, `msg`, `err` or `meta`, and `__proto__`, `constructor` and `prototype` keys are dropped.

`childLogger(inject(LOGGER), fields)` adds fields to every entry. On a `JsonLogger` it is `child()`; on any other logger (the `MemoryLogger` of `@knead-js/testing`, a `ConsoleLogger`) the fields are passed as the first meta argument, so tests capture them too.

**Redaction.** Everything goes through `@knead-js/core`'s redaction before it is written: URL userinfo, `key=value` secrets and Bearer/Basic credentials in strings and object keys, and the values of sensitive keys (`authorization`, `cookie`, `password`, `token`, `apikey`, …) in objects, class instances, Maps and Headers. Errors, wherever they appear, are only `Name: message` outside development; in development they are their redacted stack, own properties and up to 16 causes. JSON escaping (plus U+2028 and U+2029) keeps every record on one line, so a logged value cannot forge another record.

**Limits.** Values are copied 4 levels deep, at most 1000 items per array, Set, Map or object and 10000 values per record (then `[Truncated]`), so logging stays linear whatever is passed. Logging never throws: an unreadable value becomes `[unreadable]`, a cycle `[Circular]`, a failing or rejecting sink is ignored, and the default sink ignores stream errors such as EPIPE (it adds a no-op `'error'` listener to stdout and stderr on first use).

**Options.** `level` (the lowest level written; default `debug` in development, `info` otherwise), `name`, `fields` (a plain object), `development` (default: the application's `DEVELOPMENT` flag), `write(line, level)` (a custom sink; the line has no trailing newline) and `now` (the clock). Invalid options are a `LoggingConfigError` at `forRoot()`; so are importing `LoggingModule` without `forRoot()` and importing `forRoot()` twice, at startup.

**Precedence.** With `KneadFactory.create`, an explicit `logger` option (as `@knead-js/testing` passes) replaces `LoggingModule`'s logger in every module. `JsonLogger` also works on its own: `new JsonLogger(options)` implements core's `Logger`.

`bun add @knead-js/core @knead-js/logging` (`@knead-js/core` is a peer dependency). Licensed MIT OR Apache-2.0.
