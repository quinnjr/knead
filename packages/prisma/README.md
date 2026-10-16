# @knead-js/prisma

Prisma 7 integration for Knead. `PrismaModule.forRoot({ client: () => new PrismaClient({ adapter }) })`
builds the client, connects it at bootstrap and disconnects it on shutdown. Pass `{ instance }` to
manage the client yourself (it is only disconnected with `disconnectOnShutdown: true`).

Register your generated client type once so `PrismaService.db` is fully typed:

```ts
declare module '@knead-js/prisma' {
  interface PrismaClientRegistry {
    client: PrismaClient;
  }
}
```
