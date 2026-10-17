---
'@knead-js/testing': minor
---

`Test.createModule(...).compile()` passes its logger to `KneadFactory.create` as before, which now replaces every module's `LOGGER`: `mod.logs` captures entries from modules with their own `LOGGER` provider and from a global module such as `LoggingModule`, instead of only those using the default logger.
