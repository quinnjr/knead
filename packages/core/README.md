# @knead/core

Dependency injection and modules for hpmws: `inject()` in field initializers, `@Module` with enforced encapsulation, dynamic/global modules, async factories and lifecycle hooks, all on standard TC39 decorators.

`bun add @knead/core`. Every other `@knead/*` package takes it as a peer dependency; if two copies end up loaded, a one-time warning is printed because tokens and `inject()` do not work across copies. Licensed MIT OR Apache-2.0.
