import { Module } from '@knead-js/core';
import { PrismaModule } from '@knead-js/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

// #region instance
// You built it, so you own it: the module connects it at bootstrap and disconnects it at
// shutdown only because disconnectOnShutdown is true.
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

@Module({
  imports: [PrismaModule.forRoot({ instance: client, disconnectOnShutdown: true })],
})
export class InstanceAppModule {}
// #endregion instance
