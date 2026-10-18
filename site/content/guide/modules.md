---
title: Modules
description: Group providers and controllers into modules, share them through exports, and configure reusable modules with dynamic and global modules.
---

A Knead application is a graph of modules. Each module is a class decorated with `@Module()` that
declares the providers and controllers it owns, the modules it imports and the parts of itself it
shares. Providers are private to their module unless the module exports them, so a module's
public surface is explicit and a missing import fails at startup with an error that names the fix.

## Defining a module

`@Module()` takes one options object. Every field is optional.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `imports` | `ModuleImport[]` | `[]` | Module classes or dynamic modules whose exports this module can inject. |
| `providers` | `Provider[]` | `[]` | Providers this module owns. See [providers](/guide/dependency-injection/#providers). |
| `controllers` | `Type[]` | `[]` | Controller classes. They are also registered as providers of this module (not exported). |
| `exports` | `ModuleExport[]` | `[]` | Tokens and modules that importers of this module can see. |
| `global` | `boolean` | `false` | Makes this module's exports visible in every module. See [global modules](#global-modules). |

A module class needs no body. The decorator stores the options as metadata on the class; Knead
reads them when the application starts.

## Sharing providers with exports

A module can inject its own providers, the exports of the modules it imports and the exports of
[global modules](#global-modules), nothing else.
Here `DatabaseModule` owns two providers and exports one of them:

<<< core/feature-modules.ts#database title="database.module.ts"

`UsersModule` imports `DatabaseModule`, so `UsersService` can inject `Database`. It cannot inject
`ConnectionPool`, which `DatabaseModule` keeps to itself:

<<< core/feature-modules.ts#users title="users.module.ts"

The root module is the one you pass to `KneadFactory.create()` (from `@knead-js/http`) or to
[`ApplicationContext.create()`](/guide/lifecycle/#standalone-applications):

<<< core/feature-modules.ts#app title="app.module.ts"

Visibility is not transitive. `AppModule` imports `UsersModule`, which imports `DatabaseModule`,
but a provider of `AppModule` cannot inject `Database`: `UsersModule` does not export it. To use
`Database` in `AppModule`, import `DatabaseModule` there too, or have `UsersModule`
[re-export it](#re-exporting-modules).

### What a module can export

An entry in `exports` is one of:

- a token the module provides itself (a class or an `InjectionToken`);
- a token that one of its imported modules exports, which re-exports that single token;
- an imported module (its class, or the dynamic module object), which re-exports everything that
  module exports.

When two re-exported modules export the same ordinary token, the first in import order wins, as
it does for the module's own lookups. For a
[multi provider](/guide/dependency-injection/#multi-providers) token, exports add up instead: a
module exports its own contributions (when it lists the token) and those of every module it
re-exports the token from, own contributions first, then imports in import order. Listing a multi
token re-exports it from every import that exports it.

Anything else is a `ModuleDefinitionError` at startup, for example
`UsersModule exports Database, which it neither provides nor imports.`

## Re-exporting modules

A module that lists an imported module in its `exports` passes that module's exports on to its own
importers. This is useful for a shared module that bundles several others:

<<< core/reexport.ts#reexport title="shared.module.ts"

`ReportsService` can inject `Database` because `SharedModule` re-exports `DatabaseModule`.

## One instance per module

A module class appears in the graph once, however many modules import it, so its singleton
providers exist once and every importer gets the same instances.

Dynamic modules are identified by object identity instead. Each call to a `forRoot()`-style method
returns a new object, and each object is a separate module instance with its own providers. Import
a dynamic module once (usually in the root module), or store the object in a constant and import
that constant everywhere it is needed. Importing a module class plainly and as a dynamic module
also creates two instances.

## Global modules

A module with `global: true` makes its exports visible to every module in the application, without
an import. Use it for application-wide infrastructure such as configuration, logging and feature
flags:

<<< core/global-module.ts#global title="feature-flags.module.ts"

Keep these rules in mind:

- A global module must still be part of the graph: import it once, usually in the root module. A
  global module that nothing imports is not loaded at all.
- Only its exports become global. Its other providers stay private, like any module's.
- Global visibility has the lowest precedence. A module's own providers and the exports of the
  modules it imports win over a global module that provides the same token (see
  [how a provider is found](#how-a-provider-is-found)).
- If a module lists a global module in its own `imports`, that module treats it as an ordinary
  import, at its position in the list.

The modules that the `@knead-js/*` packages return from `forRoot()`, such as `ConfigModule`,
`LoggingModule` and `CorsModule`, are global.

## Dynamic modules

A dynamic module is a plain object that names a module class and adds options to it. Use one when
a module needs configuration from the importing application:

| Field | Type | Description |
| --- | --- | --- |
| `module` | `Type` | The module class. Required. It does not need its own `@Module()` decorator. |
| `imports`, `providers`, `controllers`, `exports` | as in `@Module()` | Appended after the lists in the class's `@Module()` options. |
| `global` | `boolean` | Overrides the class's `global` option when set. Otherwise the class's value applies, and `false` if it has none. |

The convention, which the `@knead-js/*` packages follow, is a static `forRoot(options)` method
that returns a `DynamicModule` and provides the options under an `InjectionToken`:

<<< core/dynamic-module.ts#options title="mail.options.ts"

<<< core/dynamic-module.ts#service title="mail.service.ts"

<<< core/dynamic-module.ts#module title="mail.module.ts"

`forRoot()` validates its options before returning, so invalid options fail when the module graph
is defined, not on the first email. `@Module()` on `MailModule` holds the parts that never change
(`MailService` and its export); the dynamic module adds `MAIL_OPTIONS`. Because the options token
is not exported, only the module's own providers can read it.

Because Knead creates every singleton at startup, importing `MailModule` without `forRoot()` fails
at startup:
`MailService (MailModule) requested MAIL_OPTIONS, but no provider is visible.` To make that
mistake clearer, a module can check for its options in a factory provider of its own and throw a
dedicated error, as `LoggingModule` does.

### Options from other providers

When the options depend on other providers (configuration loaded at startup, a secrets client),
add a `forRootAsync()` that takes `imports` and a `useFactory`. Its factory becomes a
[factory provider](/guide/dependency-injection/#factory-providers) of the dynamic module, so it
runs in the injection context and can inject the exports of the modules listed in `imports`:

<<< core/dynamic-module.ts#usage title="app.module.ts"

The factory may be `async`: Knead awaits it during startup, before it creates any class that
injects `MAIL_OPTIONS`. As with every factory, call `inject()` before the first `await`.
`ConfigModule.forRootAsync()`, `GraphQLModule.forRootAsync()` and `PrismaModule.forRootAsync()`
accept the same `imports` and `useFactory` options.

### Exporting a dynamic module

To re-export a dynamic module, list it in `exports` the same way you list a module class:

- Exporting the module class (`exports: [MailModule]`) re-exports every imported instance of that
  class, whether it was imported plainly or through any number of `forRoot()` calls.
- Exporting the dynamic module object itself re-exports only that instance. Store the object in a
  constant and use the constant in both `imports` and `exports`. If the object in `exports` is not
  one of the imported objects (for example, a second `forRoot()` call), Knead falls back to
  re-exporting every imported instance of its class.

## How a provider is found

When a provider in module `M` calls `inject(token)`, Knead looks for `token` in this order:

1. The providers of `M` itself (including its controllers).
2. The exports of the modules `M` imports, in the order of `M`'s `imports` list.
3. The exports of the global modules, in the order they appear in the module graph.
4. The application's built-in providers: `MODULES`, plus defaults for `LOGGER` and `DEVELOPMENT`
   (see the [core reference](/packages/core/)).

For an ordinary token the first match wins. The built-ins come last, so a global module that
provides `LOGGER` (such as `LoggingModule.forRoot()`) replaces the default logger everywhere. A
[multi provider](/guide/dependency-injection/#multi-providers) token is different: the result
collects the contributions of every step, in this order.

If a module registers the same token twice in its own `providers`, the later registration
replaces the earlier one.

The `ApplicationContext.get()` method used by scripts and tests is less strict than `inject()`: it
looks in the root module first, then in every module whether or not the token is exported. See
[standalone applications](/guide/lifecycle/#standalone-applications).

## Inspecting the module graph

The `MODULES` token resolves to every module of the application, as a frozen array of `ModuleRef`
objects. Any provider can inject it without an import:

<<< core/module-ref.ts#modules title="module-report.ts"

The array is in initialization order: modules passed as `globalModules` to
`ApplicationContext.create()` (the HTTP layer passes its own core module this way) come first,
then the root module's graph in post-order, so every module appears after the modules it imports
and the root module is last.

| `ModuleRef` field | Type | Description |
| --- | --- | --- |
| `name` | `string` | The module class's name. |
| `metatype` | `Type` | The module class. |
| `injector` | `ModuleInjector` | The module's injector. |
| `controllers` | `readonly Type[]` | The module's controller classes, from `@Module()` and the dynamic module combined. |
| `global` | `boolean` | Whether the module is global. |

Packages use `MODULES` to discover things across the application. `LoggingModule`, for example,
counts how many instances of itself are in the graph and fails startup if `forRoot()` was imported
more than once.

## Module definition errors

Problems with the module graph itself are reported as `ModuleDefinitionError` when the application
starts, before any provider is created:

| Message | Cause |
| --- | --- |
| `AppModule imports NotAModule, which is not a module. Did you forget @Module()?` | A class in `imports` has no `@Module()` decorator. |
| `AppModule imports 42 at index 0, which is neither a module class nor a dynamic module.` | An `imports` entry is neither a class nor an object with a `module` class. |
| `AppModule has undefined in imports at index 0. This usually means a circular file import; check the import order of your module files.` | An `imports` entry is `undefined` or `null`. |
| `The root module is undefined. This usually means a circular file import; check the import order of your module files.` | The root module passed to `create()` is `undefined` or `null`. |
| `Circular module import: A → B → A` | Modules import each other. Move what both need into a third module. |
| `UsersModule exports Database, which it neither provides nor imports.` | An `exports` entry is neither provided by the module nor exported by one of its imports. |

An `undefined` import nearly always comes from circular file imports: when `a.module.ts` and
`b.module.ts` import each other, one of the two classes is still `undefined` while the other
module's decorator runs.

A provider that is not visible is a `NoProviderError`, raised while Knead creates the singletons at
startup. Its message names the requester, the module and the likely fix:

```text
UsersService (UsersModule) requested Database, but no provider is visible. Database is provided by DatabaseModule but not exported.
```

See [missing providers](/guide/dependency-injection/#missing-providers) for the three hints it can
give.
