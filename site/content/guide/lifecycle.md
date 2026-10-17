---
title: Lifecycle
description: Run setup and teardown code with lifecycle hooks, in a defined order, and run applications without HTTP through ApplicationContext.
---

Providers often own resources: a connection pool to open before the first request, a timer to
stop, a queue to drain before the process exits. Knead calls four lifecycle hook methods on the
instances it creates, at startup and at shutdown, in an order that respects their dependencies.

## Lifecycle hooks

A hook is a method with a known name. Knead calls it if the instance has it; the interfaces exist
so TypeScript checks the signature:

| Interface | Method | When it runs |
| --- | --- | --- |
| `OnModuleInit` | `onModuleInit(): void \| Promise<void>` | At startup, after every singleton has been created. |
| `OnApplicationBootstrap` | `onApplicationBootstrap(): void \| Promise<void>` | At startup, after every `onModuleInit` has finished. |
| `BeforeApplicationShutdown` | `beforeApplicationShutdown(signal?: string): void \| Promise<void>` | At shutdown, first. Receives the signal passed to `close()`. |
| `OnModuleDestroy` | `onModuleDestroy(): void \| Promise<void>` | At shutdown, after every `beforeApplicationShutdown` has finished. |

<<< core/lifecycle.ts#hooks title="worker.ts"

Use `onModuleInit` to acquire resources a provider needs to work (connections, caches). Use
`onApplicationBootstrap` for work that needs every other provider initialized, such as starting
background jobs. At shutdown, use `beforeApplicationShutdown` to stop taking new work and
`onModuleDestroy` to release resources.

## Order

Knead keeps the instances it creates in creation order, and a dependency always finishes being
created before the class that injects it. The hooks follow that order:

1. `onModuleInit` on every instance, dependencies first.
2. `onApplicationBootstrap` on every instance, in the same order.
3. At shutdown, `beforeApplicationShutdown` on every instance, in reverse order: dependents first.
4. `onModuleDestroy` on every instance, in reverse order.

So in the example, `Database.onModuleInit` finishes before `JobRunner.onApplicationBootstrap`
starts, and `JobRunner` stops its jobs before `Database` closes the pool.

Each hook is awaited before the next one starts: hooks run one at a time, never in parallel. A
slow `onModuleInit` delays startup by its full duration.

## Which instances receive hooks

Hooks run on the objects that Knead creates while the application starts:

- instances of class providers and controllers;
- object values returned by factory providers;
- transient instances created during startup (each one receives its own hooks).

They do not run on `useValue` values, which Knead does not create, or on instances created after
startup, such as a transient provider resolved later through `ApplicationContext.get()`. An alias
(`useExisting`) does not add a second call: the aliased instance receives its hooks once.

The HTTP layer creates guards, middleware and exception filters that are not registered as
providers when the server starts listening, and runs their `onModuleInit` and
`onApplicationBootstrap` at that point. They receive shutdown hooks like any other instance. If
the application is closed while those hooks run, no further startup hook starts, and an instance
whose `onModuleInit` completes after the close began receives its shutdown hooks right away.

## Errors at startup

If an `onModuleInit` or `onApplicationBootstrap` hook throws or rejects, startup fails:

1. Knead stops running startup hooks.
2. It shuts the application down, calling `beforeApplicationShutdown` and `onModuleDestroy` on
   every instance whose `onModuleInit` completed. The instance whose `onModuleInit` failed does
   not receive shutdown hooks.
3. `ApplicationContext.create()` (and `KneadFactory.create()`) rejects with the original error.
   Errors thrown by the shutdown hooks during this cleanup never hide it: the cleanup's error (an
   `AggregateError` when several hooks failed) is kept as the original error's `shutdownError`
   property, when the original error is an object that has none yet.

A provider that opens a connection in `onModuleInit` therefore gets the chance to close it even
when a provider initialized after it fails.

## Errors at shutdown

A failing shutdown hook does not stop the others: every `beforeApplicationShutdown` and
`onModuleDestroy` still runs. After all of them, `close()` rejects with the error when one hook
failed, or with an `AggregateError` whose message is `Application shutdown failed` and whose
`errors` array holds every error when several failed.

`close()` runs the shutdown hooks once. Calling it again, or concurrently, returns the same promise.

## Standalone applications

`ApplicationContext` is the container on its own, without an HTTP server. Use it for scripts,
workers, queue consumers and CLI tools that share the application's modules:

<<< core/standalone.ts#module title="report.module.ts"

<<< core/standalone.ts#run title="run-report.ts"

`ApplicationContext.create(root, options)` builds the module graph, creates every singleton, runs
the startup hooks and resolves to the context. Its options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `overrides` | `Iterable<readonly [Token, Provider]>` | none | Replacement providers by token. See [overriding providers](/guide/dependency-injection/#overriding-providers). |
| `globalModules` | `readonly ModuleImport[]` | `[]` | Extra modules added to the graph before the root module. They are global only if they set `global: true`. |
| `logger` | `Logger` | `new ConsoleLogger()` | The value of `LOGGER`, unless a global module provides `LOGGER`. |
| `development` | `boolean` | `process.env.NODE_ENV === 'development'` | The value of the `DEVELOPMENT` token. |

The context exposes:

| Member | Description |
| --- | --- |
| `get(token)` | Resolves a token. It looks in the root module (with the usual visibility rules), then in every module, exported or not, and throws `NoProviderError` if no module provides it. |
| `collect(token)` | Every contribution to a multi token, from every module in `modules` order, exported or not. |
| `collectEntries(token)` | Like `collect()`, but pairs each value with the `injector` of the module that provides it. |
| `modules` | Every module, the same array as the [`MODULES` token](/guide/modules/#inspecting-the-module-graph). |
| `root` | The root module's `ModuleRef`. |
| `close(signal?)` | Runs the shutdown hooks once and resolves when they finish. |
| `closed` | `true` once `close()` has started, including a close caused by a failed startup hook. |

`get()` ignores exports on purpose: a script or test can reach any provider without the module
graph exporting it for that purpose. Inside the application, keep using `inject()`, which enforces
encapsulation.

## Shutdown and signals

`ApplicationContext` does not listen for process signals. A long-running standalone process
installs its own handlers and passes the signal to `close()`, which hands it to every
`beforeApplicationShutdown` hook:

<<< core/standalone-main.ts#main title="worker.main.ts"

An HTTP application does this with `app.enableShutdownHooks()` from `@knead-js/http`, which by
default handles `SIGTERM` and `SIGINT`: it stops the server, drains in-flight requests, runs the
same shutdown hooks and exits the process. See [server](/guide/server/).
