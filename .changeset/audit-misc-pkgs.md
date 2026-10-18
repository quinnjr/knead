---
'@knead-js/casl': patch
'@knead-js/prisma': patch
---

- casl: `parseGrant()` walks an object grant with `for...in` and `Object.hasOwn()`, so an oversized
  object stops being read as soon as it has more pairs than the catalog has areas (it read every
  key's descriptor first). Same keys, same order.
- casl: the README and authorization guide no longer claim nothing fails at request time: a route
  with `@PermittedFields()` but no `AbilityGuard` responds `403`.
- prisma: the docs no longer say nothing persists inside `withRollback()`: an inner
  `propagation: 'requiresNew'` run commits for real. They also say when the client shape is
  checked: an `instance` when `forRoot()` is called, a `client` factory's result at bootstrap.
