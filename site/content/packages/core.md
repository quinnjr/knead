---
title: Core
description: Reference for @knead-js/core, the dependency injection container, module system, lifecycle, metadata and logging primitives that every Knead package builds on.
---

```bash
bun add @knead-js/core
```

`@knead-js/core` is the container that the rest of Knead runs on: `inject()` and tokens, the
`@Module()` graph with its encapsulation rules, providers and scopes, lifecycle hooks and
`ApplicationContext`, the decorator metadata helpers, and the logging primitives (the `LOGGER`
token and the redaction functions) that every package logs through. It has no dependencies. The
other `@knead-js/*` packages, except `@knead-js/sanitize`, list it as a peer dependency, so install
it alongside them.

The guides explain how the pieces fit together: [modules](/guide/modules/),
[dependency injection](/guide/dependency-injection/), [lifecycle](/guide/lifecycle/) and
[logging](/guide/logging/). This page lists every export.

## Application context

### `ApplicationContext`

The application container. `KneadFactory.create()` from `@knead-js/http` and `@knead-js/testing`
build one internally; use it directly for applications without HTTP. See
[standalone applications](/guide/lifecycle/#standalone-applications).

| Member | Signature | Description |
| --- | --- | --- |
| `create` | `static create(root: ModuleImport, options?: CreateContextOptions): Promise<ApplicationContext>` | Builds the module graph, runs every singleton factory (awaiting async ones), creates every remaining singleton, then runs `onModuleInit` and `onApplicationBootstrap`. Rejects on any error; if a startup hook fails, the instances already initialized are shut down first. |
| `get` | `get<T>(token: Token<T>): T` | Resolves a token visible from the root module, otherwise from any module that provides it, exported or not. Throws `NoProviderError`. |
| `collect` | `collect<T>(token: Token<T[]>): T[]` | Every module's contributions to a multi token, in `modules` order, exported or not. |
| `collectEntries` | `collectEntries<T>(token: Token<T[]>): { value: T; injector: ModuleInjector }[]` | Like `collect()`, with the injector of the providing module. |
| `modules` | `readonly ModuleRef[]` | Every module in initialization order. |
| `root` | `ModuleRef` | The root module. |
| `close` | `close(signal?: string): Promise<void>` | Runs `beforeApplicationShutdown(signal)` then `onModuleDestroy` on every initialized instance, in reverse creation order. Idempotent: later calls return the same promise. Rejects with the only hook error, or an `AggregateError` (`Application shutdown failed`) for several. |
| `closed` | `boolean` | `true` once `close()` has started. |
| `initializeLate` | `initializeLate(): Promise<void>` | Internal to `@knead-js/http`: runs the startup hooks on instances created after `create()` (lazily built guards, middleware and filters) so they also receive shutdown hooks. |
| `trackConstructed` | `trackConstructed<T>(fn: () => T): T` | Internal to `@knead-js/http`: tracks every instance `fn` constructs (transients included), so the following `initializeLate()` gives them lifecycle hooks. Outside it, transients resolved after `create()` are not tracked. |

### `CreateContextOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `overrides` | `Iterable<readonly [Token, Provider]>` | none | Replaces the provider of each token in every module that registers it. Multi providers cannot be overridden; a token no module registers is unaffected. |
| `globalModules` | `readonly ModuleImport[]` | `[]` | Modules added to the graph before the root module. Global only if they set `global: true`. |
| `logger` | `Logger` | `new ConsoleLogger()` | The default value of `LOGGER`. A global module that provides `LOGGER` takes precedence. |
| `development` | `boolean` | `process.env.NODE_ENV === 'development'` | The default value of `DEVELOPMENT`. |

## Modules

### `Module()`

`@Module(options?: ModuleOptions)` is a class decorator that marks a class as a module. See
[modules](/guide/modules/).

### `ModuleOptions`

| Field | Type | Description |
| --- | --- | --- |
| `imports` | `ModuleImport[]` | Modules whose exports this module can inject. |
| `providers` | `Provider[]` | Providers owned by the module. |
| `controllers` | `Type[]` | Controllers, also registered as (unexported) providers. |
| `exports` | `ModuleExport[]` | Tokens and modules visible to importers. |
| `global` | `boolean` | Exports are visible in every module. Default `false`. |

### `DynamicModule`

`interface DynamicModule extends ModuleOptions { module: Type }`. A module configured at import
time, usually returned by a static `forRoot()`. Its lists are appended to those of the class's
`@Module()` options; its `global`, when set, overrides the class's. Each dynamic module object is a
separate module instance. See [dynamic modules](/guide/modules/#dynamic-modules).

### `ModuleImport` and `ModuleExport`

`type ModuleImport = Type | DynamicModule`: an entry of `imports`.
`type ModuleExport = Token | ModuleImport`: an entry of `exports`, either a token or an imported
module to re-export.

### The `MODULES` token

`InjectionToken<readonly ModuleRef[]>`. Every module of the application in initialization order,
as a frozen array. Injectable from every module without an import.

### `ModuleRef`

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | The module class's name. |
| `metatype` | `Type` | The module class. |
| `injector` | `ModuleInjector` | The module's injector. |
| `controllers` | `readonly Type[]` | The module's controllers. |
| `global` | `boolean` | Whether the module is global. |

### `ModuleInjector`

The injector of one module, reachable through `ModuleRef.injector` and `ApplicationContext.root`.
It implements `InjectorLike`. Most applications never use it directly; these members are the ones
meant for library code:

| Member | Description |
| --- | --- |
| `name` | The module's name. |
| `get(token, options?)` | Resolves a token with this module's visibility rules: own providers, then imports' exports, then global modules' exports. Throws `NoProviderError`, or returns `undefined` with `{ optional: true }`. |
| `lookup(token)` | The provider records visible for `token`, or `undefined`, without creating anything. |
| `resolveOrConstruct(cls)` | Returns `cls` from the module if it is a visible provider; otherwise creates it once per module in this module's injection context, honoring overrides. `@knead-js/http` uses it for guards, middleware and filters. |

Its other public members (`records`, `imports`, `exported`, `state`, `addProvider()`,
`ownRecords()`, `resolveRecords()`, `instantiate()`, `noProvider()`) are internal to the
container.

## Injection

### `inject()`

```text
inject<T>(token: Token<T>): T
inject<T>(token: Token<T>, options: { optional: true }): T | undefined
```

Returns the value of `token` from the current injection context. Throws `InjectionContextError`
outside an injection context (synchronously inside a field initializer, constructor or provider
factory), and `NoProviderError` when no provider is visible, unless `optional` is `true`. See
[the injection context](/guide/dependency-injection/#the-injection-context).

### `InjectOptions`

`{ optional?: boolean }`. With `optional: true`, a token with no visible provider resolves to
`undefined`.

### `runInInjectionContext()`

`runInInjectionContext<R>(injector: InjectorLike, fn: () => R): R`. Runs `fn` with `injector` as
the current injection context, restoring the previous context afterwards, and returns `fn`'s
result. The context covers only the synchronous part of `fn`.

### `isInInjectionContext()`

`isInInjectionContext(): boolean`. Whether an injection context is active.

### `InjectorLike`

`{ get<T>(token: Token<T>, options?: InjectOptions): T | undefined }`. What
`runInInjectionContext()` accepts. `ModuleInjector` implements it.

### `Injectable()`

`@Injectable(options?: InjectableOptions)`. Optional class decorator: classes are injectable without
it. It records the class's scope.

### `InjectableOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `scope` | `Scope` | `'singleton'` | The scope used when the class is a provider, unless the provider sets `scope`. |

## Tokens

### `InjectionToken`

`new InjectionToken<T>(description: string)`. A token for a value that is not a class instance;
`T` is the type `inject()` returns. Compared by identity. `description` appears in error messages;
`toString()` returns `InjectionToken(<description>)`.

### `Token`

`type Token<T = unknown> = AbstractType<T> | InjectionToken<T>`. Anything that identifies a
provider: a class (abstract or not) or an `InjectionToken`.

### `Type` and `AbstractType`

`type Type<T = unknown> = new (...args: any[]) => T` and
`type AbstractType<T = unknown> = abstract new (...args: any[]) => T`: a class and an abstract
class producing `T`.

### `tokenName()`

`tokenName(token: unknown): string`. The name used in error messages: an `InjectionToken`'s
description, a class's name (`<anonymous class>` for an unnamed class), or `String(token)`.

### `DEVELOPMENT`

`InjectionToken<boolean>`. Whether the application runs in development mode: the `development`
option of `ApplicationContext.create()`, by default `process.env.NODE_ENV === 'development'`.
`KneadFactory.create()` provides it from its own `development` option (`@knead-js/http` exports the
same token as `HTTP_DEVELOPMENT`). Injectable from every module. Packages use it to decide whether
to log full errors and unmask error responses, so it fails closed: anything other than exactly
`'development'` is production.

## Providers

### `Provider`

```text
type Provider<T = any> = Type<T> | ClassProvider<T> | ValueProvider<T> | FactoryProvider<T> | ExistingProvider<T>
```

An entry of a module's `providers`. A bare class is shorthand for `{ provide: C, useClass: C }`.
See [providers](/guide/dependency-injection/#providers).

Every object form has `provide: Token<T>`, and optionally `multi: true`, in which case `provide`
is a `Token<T[]>` and each provider contributes one element.

| Type | Fields | Scope |
| --- | --- | --- |
| `ClassProvider` | `useClass: Type<T>`, `scope?: Scope` | `scope`, else the class's `@Injectable()` scope, else `'singleton'` |
| `ValueProvider` | `useValue: T` | Always `'singleton'` |
| `FactoryProvider` | `useFactory: () => T \| Promise<T>`, `scope?: Scope` | `scope`, else `'singleton'`. A transient factory cannot return a promise. |
| `ExistingProvider` | `useExisting: Token<T>` | Always `'singleton'` (an alias) |

### `Scope`

`type Scope = 'singleton' | 'transient'`. A singleton is created once per registering module and
cached; a transient provider creates a new value for every injection.

### `normalizeProvider()` and `NormalizedProvider`

`normalizeProvider(provider: Provider): NormalizedProvider` converts any provider form to the
internal shape the container uses:

```text
| { kind: 'class'; token: Token; useClass: Type; scope: Scope; multi: boolean }
| { kind: 'value'; token: Token; value: unknown; scope: 'singleton'; multi: boolean }
| { kind: 'factory'; token: Token; factory: () => unknown; scope: Scope; multi: boolean }
| { kind: 'existing'; token: Token; existing: Token; scope: 'singleton'; multi: boolean }
```

It throws `ProviderConfigError` for anything that is not a class or an object with `provide`, and
for an object without `useClass`, `useValue`, `useFactory` or `useExisting`. The message describes an
invalid object by its keys only (never its values, which may be credentials), and any other value
redacted and capped at 64 characters.

## Lifecycle hooks

Interfaces for the hook methods Knead calls on the instances it creates. See
[lifecycle](/guide/lifecycle/) for order and error handling.

| Interface | Method |
| --- | --- |
| `OnModuleInit` | `onModuleInit(): void \| Promise<void>` |
| `OnApplicationBootstrap` | `onApplicationBootstrap(): void \| Promise<void>` |
| `BeforeApplicationShutdown` | `beforeApplicationShutdown(signal?: string): void \| Promise<void>` |
| `OnModuleDestroy` | `onModuleDestroy(): void \| Promise<void>` |

## Errors

Every error extends `KneadError`, whose `name` is the subclass's name (`'NoProviderError'`, ...).

| Class | Raised when |
| --- | --- |
| `KneadError` | Base class of the errors below, and of package errors such as configuration errors. |
| `InjectionContextError` | `inject()` runs outside an injection context. |
| `NoProviderError` | No provider for the token is visible from the requesting module. The message names the requester, the module and a fix. |
| `CircularDependencyError` | Providers depend on each other. Its `path: string[]` holds the cycle, for example `['A', 'B', 'A']`. |
| `ModuleDefinitionError` | The module graph is invalid: an import that is not a module, an `undefined` import, a circular module import, an unresolvable export. |
| `ProviderConfigError` | A provider is malformed, a token is registered in one module both with and without `multi: true`, or a transient factory returns a promise. |

Messages are listed in [module definition errors](/guide/modules/#module-definition-errors),
[missing providers](/guide/dependency-injection/#missing-providers) and
[circular dependencies](/guide/dependency-injection/#circular-dependencies).

## Metadata

Typed helpers over TC39 decorator metadata (`Symbol.metadata`), which `@knead-js/core` defines when
it loads if the runtime does not. Functions taking `meta` are for use inside a decorator, with
`context.metadata`; functions taking `target` read from a decorated class. Values returned by the
read functions may be shared with parent classes: treat them as read-only and change metadata only
through the set and append functions. See
[decorators and metadata](/guide/dependency-injection/#decorators-and-metadata).

### `MetadataKey`

`new MetadataKey<T>(description: string)`. A typed metadata key. Each instance owns a unique
`symbol`, so keys never collide.

### Class metadata

| Function | Description |
| --- | --- |
| `setMetadata(meta, key, value)` | Sets a value for the class. |
| `appendMetadata(meta, key, ...items)` | Appends to a list (`MetadataKey<T[]>`), copying an inherited list first so the parent's is never changed. |
| `readMetadata(meta, key)` | Reads a value inside a decorator, including one inherited from a parent class. |
| `getMetadata(target, key)` | Reads a value from a class, including one inherited from a parent class. |
| `getOwnMetadata(target, key)` | Reads a value the class itself set, ignoring inherited values. |

### Method metadata

| Function | Description |
| --- | --- |
| `setMethodMetadata(meta, method, key, value)` | Sets a value for one method (`method` is `context.name`). |
| `appendMethodMetadata(meta, method, key, ...items)` | Appends to a method's list without changing a parent class's list. |
| `readMethodMetadata(meta, method, key)` | Reads a method's value inside a decorator. |
| `getMethodMetadata(target, method, key)` | Reads a method's value from a class, including values inherited for that method. |

### `INJECTABLE` and `MODULE_METADATA`

The keys Knead's own decorators use: `INJECTABLE` is a `MetadataKey<{ scope: Scope }>` written by
`@Injectable()`, `MODULE_METADATA` a `MetadataKey<ModuleOptions>` written by `@Module()`.

## Logging

The logger interface and the redaction functions that every Knead package uses. The
[logging guide](/guide/logging/) shows how to configure logging for an application;
`@knead-js/logging` provides a JSON logger.

### `LOGGER` and `Logger`

`LOGGER` is an `InjectionToken<Logger>`, injectable from every module. Its default is the
`logger` option of `ApplicationContext.create()` (a `ConsoleLogger` unless set); a global module
that provides `LOGGER`, such as `LoggingModule.forRoot()`, replaces it everywhere.

`Logger` is the interface any logger implements:

```text
debug(message: string, ...meta: unknown[]): void
info(message: string, ...meta: unknown[]): void
warn(message: string, ...meta: unknown[]): void
error(message: string, ...meta: unknown[]): void
```

### `ConsoleLogger`

`new ConsoleLogger(prefix = 'knead')`. Writes to `console.debug`, `console.info`, `console.warn` and
`console.error`, with the message prefixed by `[prefix] `. Before printing:

- the message and string `meta` values go through `redactCredentials()` and then `escapeControl()`,
  so credentials are masked and a value containing a newline cannot forge a second log line;
- other `meta` values go through `redactValue()`.

The originals are never modified. A `ConsoleLogger` never throws: if formatting fails (for
example, a non-string message from untyped code), it prints the message converted with
`String()`, still redacted and escaped, followed by `[unloggable arguments]`. A message that
cannot even be converted prints as `[unloggable message]`, and a failing `console` call is
ignored.

### `MemoryLogger`

Records every call in `entries: LogEntry[]`, exactly as logged; `clear()` empties it.
`@knead-js/testing` uses it by default. It does not redact anything, so use it only in tests.

### `DeferredLogger` and `WarnLogger`

`type WarnLogger = Pick<Logger, 'warn'>`. `new DeferredLogger(target, fallback)` holds the warnings
of an object built outside dependency injection, such as a Redis store passed in module options,
until a logger is known:

| Member | Description |
| --- | --- |
| `warn(message)` | Sends `message` to the current logger, or holds it while there is none. |
| `attach(logger)` | Sends the held warnings, and every later one, to `logger`. Ignored once a logger is set, so an explicit `target` always wins. |
| `use()` | Called when the object is first used: with no logger attached by then, `fallback()` becomes the logger. |

`RedisStore` (`@knead-js/rate-limit`) and `RedisLockStore` (`@knead-js/schedule`) use it so their
construction warnings reach the application's `LOGGER`.

### `LogEntry` and `LogLevel`

`type LogLevel = 'debug' | 'info' | 'warn' | 'error'` and
`interface LogEntry { level: LogLevel; message: string; meta: unknown[] }`.

### `logError()` and `ErrorLogOptions`

`logError(options: ErrorLogOptions, message: string, error: unknown, level: 'error' | 'warn' = 'error'): string`
logs an error under a new correlation id (`crypto.randomUUID()`) and returns the id, which you can
show to an operator or put in an error response.
`ErrorLogOptions` is `{ readonly logger: Logger; readonly development: boolean }`; pass the
injected `LOGGER` and `DEVELOPMENT`.

| `development` | What is logged |
| --- | --- |
| `true` | `<message> (correlation id <id>)`, with the full error as meta, credentials redacted. An `Error` stays an `Error`: one with nothing to redact is passed as is, and one that needed redacting is passed as a copy whose `message` is redacted and whose `stack` is the redacted stack, causes and properties (`redactValue()`'s text). Other values are passed through `redactValue()`. |
| `false` | `<message> (correlation id <id>): <summarizeError(error)>`, with no meta: only `Name: message`, no stack, cause or properties, which tend to hold request data. |

The message is passed through `redactCredentials()` in both cases. A logger that throws is
ignored, so logging can never turn an error response into a second error. `logError()` does not
escape control characters in `message`; wrap client-controlled parts in `logValue()`.

<<< core/logger.ts#inject title="cache-warmer.ts"

### `redactCredentials()`

`redactCredentials(text: string): string`. Replaces credentials in a string with `***`:

- **URL userinfo**, for any scheme: `redis://user:pass@host` becomes `redis://***@host`. The
  userinfo runs to the last `@` within the first 1024 characters after `://` (passwords often
  contain unencoded `@` or `/`), and a URL ends at whitespace, a quote or an angle bracket. An
  `http(s)` URL that starts with `host[:port]/` is exempt, since an `@` there is part of the path,
  but credential URLs nested in its path or query are still redacted.
- **Secret `key=value` pairs** whose key contains `password`, `passwd`, `pwd`, `secret`, `token`,
  `apikey`, `api_key` or `accountkey`, in any case and with any prefix or suffix (`access_token=`,
  `DB_PASSWORD=`, `PGPASSWORD=`). The value runs to the next `&`, `;` or whitespace. Keys longer
  than 64 characters are read only up to 64.
- **`Bearer` and `Basic` credentials**, in any case, when the credential has at least 8 token
  characters or is a `user:pass`-style pair. Shorter values, such as `Bearer abc123`, are not
  redacted, so ordinary prose stays readable.

Passwords containing spaces or quotes cannot appear unencoded in a valid URL and are not
recognized, nor is userinfo longer than 1024 characters. The work is linear in the input length.

### `redactValue()`

`redactValue(value: unknown): unknown`. A copy of `value` with credentials redacted, for logging.
The original is never modified, and a value with nothing to redact is returned as is (the same
object).

- Strings go through `redactCredentials()`.
- Plain objects and arrays are walked up to 4 levels deep; deeper values become `[Object]` or
  `[Array]`, and cycles become `[Circular]`. String keys are redacted too.
- A key equal to `authorization`, `cookie`, `set-cookie`, `password`, `passwd`, `pwd`, `secret`,
  `token`, `apikey`, `api_key`, `accesstoken`, `refreshtoken`, `accountkey`, `privatekey` or
  `connectionstring` (any case) has its value replaced by `***`, whatever the value (`null` and
  `undefined` stay).
- A key that contains `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `accountkey`,
  `privatekey`, `connectionstring`, `authorization`, `cookie`, `credential` or `sessionid` once
  lowercased and stripped of `-` and `_` (`db_password`, `x-api-key`, `clientSecret`) has its value
  replaced by `***` too, except numbers, booleans, bigints, `null` and `undefined`
  (`maxTokens: 100` stays). Keys longer than 128 characters are not checked for these words.
- `Headers`, `Map` and other objects with an `entries()` or `toJSON()` method are walked as their
  entries, and replaced by a plain object only when something in them was redacted. Like plain
  objects, one past the depth limit becomes `[Object]` and one in a cycle becomes `[Circular]`.
- An `Error` whose message, stack, cause chain or own properties (including
  `AggregateError.errors`) need redacting becomes a string: its redacted stack, each cause as a
  `Caused by:` line (followed by the cause's own redacted properties, or, for a cause that is not
  an Error, the redacted cause itself), and its redacted own properties. An error with a cause chain longer than 16
  is always turned into this string, ending with `Caused by: … (more causes omitted)`. Other
  errors are returned unchanged.
- Other class instances are returned as is. A property whose getter throws becomes
  `[unreadable]`, and a value that defeats the walk (an exotic `Proxy`) becomes
  `[unloggable value: <summary>]`.

### `summarizeError()`

`summarizeError(error: unknown): string`. `Name: message` for logs outside development, with no
stack, cause or properties. The name is the error's string `name`, `Error` for an object without
one, or the `typeof` of a non-object. The message is redacted with `redactCredentials()`, then
truncated to `LOGGED_MESSAGE_LENGTH` characters followed by `…` (dropping a trailing `scheme://`
fragment that the cut left without its `@`), then both parts go through `logValue()`.

### `logValue()`

`logValue(value: unknown): string`. Makes a client-controlled value (a path, an id, a topic) safe
to interpolate into a log message: `String(value)`, truncated to `MAX_LOGGED_VALUE_LENGTH`
characters followed by `…`, with control characters escaped.

### `escapeControl()`

`escapeControl(text: string): string`. Escapes C0 control characters (U+0000 to U+001F) and DEL:
`\n`, `\r` and `\t` as those two-character sequences, the rest as `\xNN`.

### `LOGGED_MESSAGE_LENGTH` and `MAX_LOGGED_VALUE_LENGTH`

`LOGGED_MESSAGE_LENGTH` is `500`, the longest error message `summarizeError()` keeps.
`MAX_LOGGED_VALUE_LENGTH` is `1024`, the longest value `logValue()` keeps.

## Network helpers

Address parsing and Redis URL checks shared by the HTTP, rate-limit, GraphQL and schedule
packages.

### `parseIp()`

`parseIp(ip: string): Uint8Array | undefined`. Parses an IPv4 or IPv6 address: 4 bytes for IPv4
and for IPv4-mapped IPv6 (`::ffff:10.0.0.1`), 16 bytes for other IPv6 addresses (an IPv6 zone such
as `%eth0` is ignored), `undefined` for anything invalid.

### `isLoopbackHostname()`

`isLoopbackHostname(hostname: string): boolean`. Whether a URL hostname is loopback: `localhost`,
`localhost.`, `127.0.0.0/8` or `::1`, case-insensitive, with or without brackets, including
IPv4-mapped forms.

### `plaintextRedisHost()`

`plaintextRedisHost(url: string | undefined): string | undefined`. The `host[:port]` of a
`redis://` or `valkey://` URL whose host is not loopback, otherwise `undefined`: TLS URLs
(`rediss://`, `valkeys://`), Unix sockets, loopback hosts, URLs with no host (`redis://`),
unparseable URLs, `undefined` and `''`.
Packages use it to warn about unencrypted connections to remote Redis servers.

### `defaultRedisUrl()`

`defaultRedisUrl(): string | undefined`. The URL `Bun.redis` connects to when given none:
`process.env.REDIS_URL`, else `process.env.VALKEY_URL`, else `undefined` (Bun then connects to
localhost). Empty values count as unset.

### `sendRedisCommand()`

`sendRedisCommand<T>(client: RedisClient, send: () => Promise<T>, timeoutMs: number, connect = true): Promise<T>`.
Runs `send`, a command on `client`, connecting the client first when `connect` is true and it is
disconnected (a client without the offline queue rejects sends while disconnected). Rejects with
`Redis did not answer within <timeoutMs>ms` when no answer arrives in time, and never runs `send`
after that, so a late command cannot act on an operation already reported as failed. The Redis
stores of `@knead-js/rate-limit` and `@knead-js/schedule` send their commands through it.
