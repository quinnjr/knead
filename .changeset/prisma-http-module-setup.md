---
'@knead-js/prisma': patch
---

Importing `PrismaHttpModule.forRoot()` more than once, or `PrismaHttpModule` without `forRoot()`, fails at startup with a `KneadError`. Before, a second import's `map` was silently ignored (the first filter answered every Prisma error) and a bare import registered no filter.
