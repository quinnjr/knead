---
'@knead-js/core': patch
'@knead-js/config': patch
'@knead-js/logging': patch
---

Audit fixes for core, config and logging:

- core: re-exporting modules that contribute to a multi token now collects every contribution
  (the module's own first, then each re-exported module in import order) instead of keeping only
  one module's. When two re-exported modules export the same ordinary token, the first in import
  order wins.
- core: a malformed provider (`provide` or `useExisting` that is not a class or an
  `InjectionToken`, a `useClass` that is not a class, a `useFactory` that is not a function) is a
  `ProviderConfigError` when the module graph is built, with a circular-import hint for
  `undefined`, instead of a later `TypeError` or a silently registered provider.
- core: `ApplicationContext.create()` rejects a `development` option that is not a boolean
  (`KneadError`), and `logError()` writes full error detail only when `development === true`.
- core: `ApplicationContext.modules` is the same frozen array as the `MODULES` token.
- config: `Config` no longer throws at boot on a typed array, `Buffer` or `ArrayBuffer` value
  (their bytes stay mutable), and it freezes objects under symbol keys too.
- logging: `JsonLogger` and `LoggingModule.forRoot()` reject a `development` option that is not a
  boolean (`LoggingConfigError`). `childLogger()` over any logger redacts the fields once and drops
  the reserved keys, and uses one error message for invalid fields whatever the logger.
