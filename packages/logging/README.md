# @knead-js/logging

`LoggingModule.forRoot(options)`: makes a `JsonLogger` the application's `LOGGER`, so the framework (request errors, `listen()`, WebSockets, GraphQL) and your providers all write one JSON object per line (NDJSON) to stdout (debug, info) and stderr (warn, error).

```ts
import { inject, LOGGER, Module } from '@knead-js/core';
import { JsonLogger, LoggingModule } from '@knead-js/logging';

@Module({ imports: [LoggingModule.forRoot({ level: 'info', fields: { service: 'api' } })] })
class AppModule {}

class ReportJob {
  readonly log = inject(JsonLogger).child({ job: 'report' });

  run() {
    this.log.info('report sent', { rows: 42 });
    // {"time":"2026-10-16T12:00:00.000Z","level":"info","logger":"knead","msg":"report sent","service":"api","job":"report","rows":42}
  }
}
```

Each record starts with `time` (ISO 8601), `level`, `logger` (the `name` option, default `knead`) and `msg`; these four keys cannot be overwritten. Then come the logger's `fields`, its `child()` fields, and the entry's meta: a plain-object argument is merged in as fields (later ones win), the first Error is `err`, and any other argument is collected in a `meta` array.

**Redaction.** Everything goes through `@knead-js/core`'s redaction before it is written: URL userinfo, `key=value` secrets and Bearer/Basic credentials in strings, and the values of sensitive keys (`authorization`, `cookie`, `password`, `token`, `apikey`, …) in objects, class instances, Maps and Headers. Errors, wherever they appear, are only `Name: message` outside development, and their redacted stack, cause chain and properties in development. JSON escaping (plus U+2028 and U+2029) keeps every record on one line, so a logged value cannot forge another record.

**Options.** `level` (the lowest level written; default `debug` in development, `info` otherwise), `name`, `fields`, `development` (default: the application's `DEVELOPMENT` flag), `write(line, level)` (a custom sink; the line has no trailing newline) and `now` (the clock). Invalid options are a `LoggingConfigError` at `forRoot()`. Logging never throws: an unreadable value becomes `[unreadable]`, a cycle `[Circular]`, and a failing sink is ignored.

**Precedence.** With `KneadFactory.create`, an explicit `logger` option (as `@knead-js/testing` passes) replaces `LoggingModule`'s logger in every module. Without one, `LoggingModule`'s logger is the `LOGGER` everywhere. `JsonLogger` also works on its own: `new JsonLogger(options)` implements core's `Logger`.

`bun add @knead-js/core @knead-js/logging` (`@knead-js/core` is a peer dependency). Licensed MIT OR Apache-2.0.
