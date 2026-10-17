---
'@knead-js/prisma': patch
---

Documents that `@prisma/adapter-pg` 7.10 and later report a violated unique index by name (`constraint.index`) rather than by its fields, so in development a Postgres unique violation's problem response has `prismaCode` but no `fields`. Tested against Prisma 7.10.1.
