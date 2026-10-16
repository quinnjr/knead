# @knead-js/core

Dependency injection and modules for Knead: `inject()` in field initializers, `@Module` with enforced encapsulation, dynamic/global modules, async factories and lifecycle hooks, all on standard TC39 decorators.

`bun add @knead-js/core`. Every other `@knead-js/*` package takes it as a peer dependency; if two copies end up loaded, a one-time warning is printed because tokens and `inject()` do not work across copies. Licensed MIT OR Apache-2.0.
