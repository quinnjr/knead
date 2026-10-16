---
'@knead-js/http': minor
---

`KneadFactory.create` no longer registers its own `LOGGER`: a global module's `LOGGER` (such as `LoggingModule`'s) is now used in every module, not only in the modules that import it. The `logger` option replaces every module's `LOGGER`, including a global module's.
