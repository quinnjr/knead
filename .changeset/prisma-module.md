---
'@knead-js/prisma': minor
---

New `@knead-js/prisma` package: `PrismaModule.forRoot()` / `forRootAsync()` and `PrismaService`, which connects the Prisma 7 client at bootstrap and disconnects it on shutdown. Register your client type through `PrismaClientRegistry` to type `PrismaService.db`.
