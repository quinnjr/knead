---
title: Dependency injection
description: Declare dependencies with inject(), register providers in modules, and let Knead create, share and wire every instance at startup.
---

Knead creates the objects your application is made of (services, repositories, controllers,
guards) and hands each one the dependencies it asks for. A class asks with `inject(Token)` in a
field initializer; a module registers a provider that tells Knead how to produce the value for that
token. Knead builds every singleton at startup, so a missing or misconfigured dependency fails
immediately with an error that names it, never in the middle of a request.

## Injecting with `inject()`

Call `inject()` in a field initializer. It returns the instance for the token, typed from the
token:

<<< core/injection.ts#basic title="cart.service.ts"

Both classes are registered as providers of the same module (`providers: [PriceFormatter,
CartService]`), so `CartService` can inject `PriceFormatter`. When Knead creates `CartService`, it
runs the field initializers inside an injection context, and `inject(PriceFormatter)` returns the
module's single `PriceFormatter`.

`inject()` also works in the constructor body:

<<< core/injection.ts#constructor title="invoice.service.ts"

Constructor parameters are not injected. Knead does not use `reflect-metadata` or
`emitDecoratorMetadata`, so there is no parameter type information to read; Knead always calls the
constructor with no arguments.

## Tokens

A token identifies a dependency. There are two kinds:

- **A class.** The class is its own token: `inject(PriceFormatter)` returns a `PriceFormatter`.
  Abstract classes work too, which lets you inject an interface-like base class and choose the
  implementation in the module.
- **An `InjectionToken<T>`.** For values that are not class instances (configuration objects,
  strings, functions, interfaces), create a token with a type parameter and a description:

<<< core/providers.ts#tokens title="app-config.ts"

`inject(APP_CONFIG)` returns an `AppConfig`. The description appears in error messages, and
`String(APP_CONFIG)` is `InjectionToken(APP_CONFIG)`. Tokens are compared by identity, so two
tokens with the same description are different tokens: create each token once and import it
wherever you need it.

<<< core/providers.ts#abstract title="cache.ts"

## Providers

A provider tells a module how to produce the value of a token. The `providers` array of
`@Module()` accepts these forms:

| Form | Value of the token | Scope |
| --- | --- | --- |
| `SomeClass` | A `SomeClass` instance. Shorthand for `{ provide: SomeClass, useClass: SomeClass }`. | From `@Injectable()`, default singleton |
| `{ provide, useClass }` | An instance of `useClass`. | `scope` option, else from `@Injectable()` on `useClass`, default singleton |
| `{ provide, useValue }` | `useValue` itself. | Always singleton |
| `{ provide, useFactory }` | The factory's return value, or what its promise resolves to. | `scope` option, default singleton |
| `{ provide, useExisting }` | The value of another token: an alias. | Always singleton |

Every object form also accepts `multi: true`. See [multi providers](#multi-providers).

<<< core/providers.ts#forms title="app.providers.ts"

### Class providers

A class provider creates the instance with `new`, inside the injection context of the module that
registers it, so its field initializers can call `inject()`. With `useClass`, the token and the
class differ: `{ provide: Cache, useClass: MemoryCache }` makes `inject(Cache)` return a
`MemoryCache`.

### Value providers

A value provider returns the value as is. Knead does not copy it, and does not call
[lifecycle hooks](/guide/lifecycle/) on it, even when it is an object with an `onModuleInit`
method.

### Factory providers

A factory provider calls `useFactory` with no arguments, inside the injection context, so the
factory calls `inject()` for whatever it needs. Call `inject()` in the factory body itself, not in
a callback the factory returns: the callback runs later, outside the injection context. The
`HEALTH_CHECKS` example [below](#multi-providers) shows the right way.

### Async factories

A singleton factory may return a promise. During startup, Knead runs every singleton factory and
awaits the async ones before it creates the remaining classes, so a class can inject the resolved
value directly:

<<< core/providers.ts#async title="secrets.ts"

The rules:

- **Call `inject()` before the first `await`.** The injection context ends when the factory first
  awaits. An `inject()` after it throws `InjectionContextError`, which rejects startup.
- **The start of a factory can run more than once.** When a factory injects an async provider that
  has not settled yet, Knead awaits that provider and then calls the factory again, so the code
  before that `inject()` runs twice. Keep everything before the first `await` free of side
  effects: only `inject()` calls.
- **A rejected promise fails startup.** `ApplicationContext.create()` (and `KneadFactory.create()`)
  rejects with the factory's error.
- **Transient factories cannot be async.** A transient factory that returns a promise throws
  `ProviderConfigError`: `Transient provider SECRETS cannot use an async factory.`

### Aliases

`useExisting` makes a token resolve to the same value as another token. In the providers above,
`inject(LEGACY_CACHE)` and `inject(Cache)` return the same `MemoryCache` instance. The aliased
token is looked up from the module that registers the alias.

### Multi providers

With `multi: true`, several providers contribute to one token, and `inject()` returns an array of
every contribution. The token's type is the array type:

<<< core/providers.ts#multi title="health.ts"

Contributions keep their registration order within a module. A token that a module, its imports
and global modules all contribute to resolves to the module's own contributions first, then those
of its imports (in import order), then those of global modules. Contributions from other modules
are only included when those modules export the token.

Registering one token in the same module both with and without `multi: true` is a
`ProviderConfigError`:

```text
HEALTH_CHECKS is registered in AppModule both with and without multi: true.
```

The `@knead-js/http` package uses multi tokens such as `APP_MIDDLEWARE` and `APP_GUARD` to
let any module contribute global middleware and guards.

### Invalid providers

A malformed provider is a `ProviderConfigError` when the module graph is built:

- `Invalid provider: 42. Expected a class or an object with "provide".`
- `Provider for APP_CONFIG must define useClass, useValue, useFactory or useExisting.`
- `UsersService is listed in the providers of UsersModule but is not decorated with @Injectable().`
- `The provider for MAILER in AppModule uses SmtpMailer, which is not decorated with @Injectable().`
- `The provider for MAILER in AppModule: useClass is undefined. This usually means a circular file import; check the import order of your files.`
- `The provider for CLOCK in AppModule: useFactory must be a function, got 42.`

`provide` and `useExisting` must be a class or an `InjectionToken`, `useClass` a class and
`useFactory` a function.

## Scopes

Every provider is a singleton by default: one instance per module that registers it, shared by
everything that injects it, created at startup and cached.

A transient provider creates a new instance for every injection. Mark a class with
`@Injectable({ scope: 'transient' })`, or set `scope: 'transient'` on a `useClass` or `useFactory`
provider (the `scope` option takes precedence over `@Injectable()`):

<<< core/providers.ts#transient title="request-id.ts"

`AuditLog` and `AccessLog` each get their own `RequestIdGenerator`. Transient instances are created
when something injects them, not eagerly at startup.

Every class the container constructs as a provider, whether listed directly (`providers: [Cls]`)
or through `useClass`, must carry `@Injectable()`; its only option is `scope`. Value, factory and
alias providers need no decorator, nor do guard, middleware and filter classes. Controllers and
resolvers are marked by `@Controller()` and `@Resolver()`, and exception filters by `@Catch()`. A
subclass of a marked class is marked too and inherits its scope.

> [!NOTE]
> There is no request scope. A transient provider is still created when the class that injects it
> is created, which for a singleton is once, at startup. For per-request data, read the request
> context in the handler; see [request context](/guide/request-context/).

## Optional dependencies

Pass `{ optional: true }` to get `undefined` instead of an error when no provider is visible:

<<< core/injection.ts#optional title="checkout.service.ts"

The return type becomes `Tracer | undefined`. The option only covers a missing provider: if a
provider is visible but creating it throws, the error is not swallowed.

## The injection context

`inject()` only works while Knead is creating something: synchronously inside a field initializer,
a constructor or a provider factory. Anywhere else it throws `InjectionContextError`:

```text
inject(CLOCK) was called outside an injection context. inject() only works synchronously inside field initializers, constructors and provider factories; call it before the first await.
```

The common mistake is calling `inject()` in a method:

<<< core/injection-context.ts#wrong title="reminder.service.ts"

Inject in a field instead, and use the field in the method:

<<< core/injection-context.ts#right title="reminder.service.ts"

In an async factory, the context ends at the first `await`:

<<< core/injection-context.ts#async title="start-time.ts"

Two lower-level functions let library code work with the context directly.
`runInInjectionContext(injector, fn)` runs `fn` with `injector` as the current context and returns
its result. `isInInjectionContext()` reports whether a context is active. A module injector (the
`injector` field of a `ModuleRef`, or `context.root.injector`) can be passed as the injector:

<<< core/injection-context.ts#run title="build-reminder.ts"

An instance built this way is not a provider: Knead does not cache it, and it does not receive
lifecycle hooks.

## Startup resolution

`ApplicationContext.create()`, which `KneadFactory.create()` and `@knead-js/testing` both use,
resolves the whole application before it returns:

1. It builds the module graph and registers every provider, which reports
   [module definition errors](/guide/modules/#module-definition-errors) and invalid providers.
2. It runs every singleton factory, in module order, awaiting async ones.
3. It creates every remaining singleton (classes, controllers, aliases).
4. It runs the `onModuleInit` and `onApplicationBootstrap` [lifecycle hooks](/guide/lifecycle/).

A missing provider, a cycle or a throwing constructor in any singleton therefore fails startup,
even if no request would ever reach that code.

## Circular dependencies

Knead does not resolve circular dependencies; there is no `forwardRef()`. A cycle throws
`CircularDependencyError` with the full path:

<<< core/circular.ts#cycle title="orders.service.ts"

```text
Circular dependency detected: OrdersService → InvoicesService → OrdersService
```

The error's `path` property holds the same names as an array. Cycles through aliases and async
factories are detected the same way. To fix one, move the logic both classes need into a third
provider that depends on neither:

<<< core/circular.ts#fix title="billing.ts"

Modules importing each other are a different error, a `ModuleDefinitionError`; see
[module definition errors](/guide/modules/#module-definition-errors).

## Missing providers

When no provider for a token is visible, `inject()` throws `NoProviderError`. The message names the
class that asked, its module and the token, followed by one of three hints:

| Situation | Hint |
| --- | --- |
| No module provides the token. | `No module provides Db. Add it to the providers of UsersModule or of a module that UsersModule imports.` |
| Another module provides it but does not export it. | `Db is provided by DatabaseModule but not exported.` |
| Another module exports it, but this module does not import that module. | `Db is exported by DatabaseModule; add DatabaseModule to the imports of UsersModule.` |

For example:

```text
UsersService (UsersModule) requested Db, but no provider is visible. Db is provided by DatabaseModule but not exported.
```

## Overriding providers

`ApplicationContext.create()` accepts `overrides`: pairs of a token and a replacement provider. An
override replaces the provider for that token in every module that registers it, and is resolved in
that module, so a `useClass` override can inject what the original could:

<<< core/overrides.ts#overrides title="checkout.test.ts"

Overrides apply to tokens that some module registers, plus the classes that `@knead-js/http`
creates on demand (guards, middleware and exception filters). An override for a token that no
module provides has no effect, and multi providers cannot be overridden. In tests, use the
`overrideProvider()`, `overrideGuard()` and related methods of `@knead-js/testing`, which build on
this option; see [testing](/guide/testing/).

## Decorators and metadata

Knead uses standard TC39 decorators, the ones TypeScript compiles without
`experimentalDecorators`. Leave `experimentalDecorators` (and with it `emitDecoratorMetadata`) off
in your `tsconfig.json`: with it on, decorators use the legacy semantics, which Knead's decorators
do not support.

Decorators record their options with decorator metadata (`Symbol.metadata`), not
`reflect-metadata`. Bun 1.4 does not define `Symbol.metadata` yet, so `@knead-js/core` installs it
when it loads. Import `@knead-js/core` (or any `@knead-js/*` package) before defining decorated
classes; normal imports at the top of a file already guarantee this.

The same helpers are available for your own decorators. A `MetadataKey<T>` is a typed key, and
the `set`, `append`, `read` and `get` functions store and read values on the class or per method:

<<< core/metadata.ts#keys title="audit.decorators.ts"

<<< core/metadata.ts#use title="invoice.controller.ts"

Metadata follows class inheritance: `getMetadata()` on a subclass returns its parent's value unless
the subclass sets its own, while `getOwnMetadata()` ignores inherited values. `appendMetadata()` on
a subclass copies the parent's list before appending, so the parent's list never changes.
Each `MetadataKey` owns a unique symbol, so two keys never collide, even with the same
description. The full list of helpers is in the
[core reference](/packages/core/#metadata).

## One copy of `@knead-js/core`

Tokens, module metadata and `inject()` rely on module-level identity, so every `@knead-js/*`
package must load the same copy of `@knead-js/core` (it is a peer dependency of all of them). If
two different copies load, for example after a version mismatch leaves a nested install, the
second copy prints one warning:

```text
[knead] Multiple copies of @knead-js/core are loaded (...). Injection tokens, module metadata and inject() will not work across them; make sure every @knead-js/* package resolves the same @knead-js/core (it is a peer dependency).
```

Align the versions of your `@knead-js/*` packages and reinstall to fix it.
