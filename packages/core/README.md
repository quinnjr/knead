# @knead-js/core

[![npm](https://img.shields.io/npm/v/@knead-js/core?color=c2410c&label=npm)](https://www.npmjs.com/package/@knead-js/core)
[![CI](https://github.com/quinnjr/knead/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/quinnjr/knead/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](https://github.com/quinnjr/knead#license)

The dependency injection container and module system that every Knead package builds on:
`inject()` in field initializers, `@Module()` with enforced encapsulation, dynamic and global
modules, async factories and lifecycle hooks, all on standard TC39 decorators.

**[Documentation](https://quinnjr.github.io/knead/packages/core/)** · [Guide](https://quinnjr.github.io/knead/guide/modules/) · [Knead](https://github.com/quinnjr/knead)

## Install

```bash
bun add @knead-js/core
```

Requires Bun 1.4.3 or newer. `@knead-js/core` has no dependencies. Every other `@knead-js/*`
package except `@knead-js/sanitize` lists it as a peer dependency, so install it alongside them.

## Quick start

```ts
import { ApplicationContext, InjectionToken, inject, Module } from '@knead-js/core';

interface MailConfig {
  from: string;
}

const MAIL_CONFIG = new InjectionToken<MailConfig>('MAIL_CONFIG');

export class Mailer {
  readonly #config = inject(MAIL_CONFIG);

  send(to: string, subject: string): string {
    return `${this.#config.from} -> ${to}: ${subject}`;
  }
}

@Module({
  providers: [{ provide: MAIL_CONFIG, useValue: { from: 'noreply@example.com' } }, Mailer],
  exports: [Mailer],
})
export class MailModule {}

export class SignupService {
  readonly #mailer = inject(Mailer);

  register(email: string): string {
    return this.#mailer.send(email, 'Welcome');
  }
}

@Module({ imports: [MailModule], providers: [SignupService] })
export class AppModule {}

const app = await ApplicationContext.create(AppModule);
console.log(app.get(SignupService).register('ada@example.com'));
// noreply@example.com -> ada@example.com: Welcome
await app.close();
```

`MailModule` keeps `MAIL_CONFIG` private and exports `Mailer`, so `SignupService` can inject the
mailer but not the configuration. `ApplicationContext` runs the module graph without HTTP; with
[`@knead-js/http`](https://www.npmjs.com/package/@knead-js/http), `KneadFactory.create()` builds
the same context and serves its controllers.

## Features

- **Standard decorators.** TC39 decorators and `Symbol.metadata`; no `experimentalDecorators`, no
  `reflect-metadata`, no constructor parameter types.
- **`inject()` in field initializers.** Dependencies are typed by their token, with no parameter
  decorators.
- **Enforced encapsulation.** A module sees only its own providers, its imports' exports and
  global modules' exports. Visibility is not transitive.
- **Every provider form.** Classes, values, factories (sync or async), aliases, multi providers,
  and singleton or transient scope.
- **Fails at startup, not on a request.** The whole graph is resolved before `create()` returns,
  so a missing provider, a cycle or a throwing constructor stops startup with an error that names
  the fix.
- **Dynamic and global modules.** `forRoot()`-style configuration and application-wide
  infrastructure.
- **Lifecycle hooks** in dependency order, with cleanup of already-initialized instances when
  startup fails.
- **Redacting logger.** The `LOGGER` token, a `ConsoleLogger` that masks credentials and escapes
  control characters, and the redaction helpers every package logs through.

## Modules

`@Module()` takes `imports`, `providers`, `controllers`, `exports` and `global`. An entry of
`exports` is a token the module provides, a token one of its imports exports, or an imported
module (which re-exports everything that module exports). Anything else is a
`ModuleDefinitionError` at startup.

- A module class appears in the graph once, however many modules import it, so its singletons
  exist once.
- A dynamic module (`{ module, providers, ... }`, usually from a static `forRoot()`) is identified
  by object identity: each object is a separate module instance.
- `global: true` makes a module's exports visible everywhere. It must still be imported once,
  usually in the root module, and has the lowest precedence when resolving a token.

## Providers

```ts
export class Connection {
  readonly url = inject(APP_CONFIG).databaseUrl;
}

export const CONNECTION_LABEL = new InjectionToken<string>('CONNECTION_LABEL');
export const LEGACY_CACHE = new InjectionToken<Cache>('LEGACY_CACHE');

export const providers: Provider[] = [
  // Value: the object itself, as is.
  { provide: APP_CONFIG, useValue: { databaseUrl: 'postgres://db.internal/app', port: 3000 } },
  // Class: inject(Cache) gets a MemoryCache.
  { provide: Cache, useClass: MemoryCache },
  // Shorthand for { provide: Connection, useClass: Connection }.
  Connection,
  // Factory: runs in the injection context.
  { provide: CONNECTION_LABEL, useFactory: () => `db at ${inject(Connection).url}` },
  // Alias: the same instance as Cache, under another token.
  { provide: LEGACY_CACHE, useExisting: Cache },
];
```

A token is a class (abstract or not) or an `InjectionToken<T>`, whose type parameter is what
`inject()` returns. Add `multi: true` to collect several providers into one array, and
`scope: 'transient'` (or `@Injectable({ scope: 'transient' })`) for a new value per injection.

`inject()` works only synchronously inside a field initializer, a constructor or a provider
factory. Anywhere else, including after the first `await` of an async factory, it throws
`InjectionContextError`. Pass `{ optional: true }` to get `undefined` instead of a
`NoProviderError` when no provider is visible.

Knead does not resolve circular dependencies (there is no `forwardRef()`): a cycle is a
`CircularDependencyError` whose `path` lists the classes involved.

## Lifecycle

| Hook | When it runs |
| --- | --- |
| `onModuleInit()` | At startup, after every singleton has been created, dependencies first. |
| `onApplicationBootstrap()` | After every `onModuleInit` has finished, in the same order. |
| `beforeApplicationShutdown(signal?)` | First at `close()`, in reverse order: dependents first. |
| `onModuleDestroy()` | After every `beforeApplicationShutdown`, in reverse order. |

Hooks are awaited one at a time. If a startup hook fails, the instances already initialized are
shut down and `create()` rejects with the original error. A failing shutdown hook does not stop
the others; `close()` then rejects with that error, or an `AggregateError` for several, and is
idempotent.

## Logging

`LOGGER` is injectable from every module. Its default is a `ConsoleLogger`, which runs messages and
arguments through `redactCredentials()` and `redactValue()` before printing:

- URL userinfo (`redis://***@host`), secret `key=value` pairs (`password=`, `access_token=`,
  `DB_PASSWORD=`) and `Bearer`/`Basic` credentials are masked.
- Values of sensitive keys (`authorization`, `cookie`, `password`, `token`, `apikey`, ...) in
  objects, `Headers`, `Map`s and Errors become `***`.
- Control characters are escaped, so a logged value cannot forge a log line. The originals are
  never modified, and logging never throws.

`logError()` logs an error under a correlation id and returns the id: the full redacted error in
development, only `Name: message` otherwise. Development mode is the `DEVELOPMENT` token: the
`development` option, by default `NODE_ENV === 'development'`. `MemoryLogger` keeps
entries unredacted and is for tests only.

## One copy of core

Tokens, module metadata and `inject()` rely on module identity. If two different copies of
`@knead-js/core` are loaded (for example after a version mismatch), a one-time warning is printed,
because injection does not work across them. Keep it a single, deduplicated dependency.

## Documentation

- [`@knead-js/core` reference](https://quinnjr.github.io/knead/packages/core/): every export.
- [Modules](https://quinnjr.github.io/knead/guide/modules/): exports, dynamic and global modules,
  graph errors.
- [Dependency injection](https://quinnjr.github.io/knead/guide/dependency-injection/): tokens,
  providers, scopes, the injection context, overrides.
- [Lifecycle](https://quinnjr.github.io/knead/guide/lifecycle/): hook order, errors, standalone
  applications, signals.
- [Logging](https://quinnjr.github.io/knead/guide/logging/): configuring the logger and redaction.

## License

Licensed under either of [MIT](https://github.com/quinnjr/knead/blob/develop/LICENSE-MIT) or
[Apache-2.0](https://github.com/quinnjr/knead/blob/develop/LICENSE-APACHE) at your option.
