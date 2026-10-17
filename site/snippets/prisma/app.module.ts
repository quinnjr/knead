import { Module } from '@knead-js/core';
import { PrismaModule } from '@knead-js/prisma';
import { PrismaHttpModule } from '@knead-js/prisma/http';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { UsersModule } from './users.module.js';

// #region module
@Module({
  imports: [
    PrismaModule.forRoot({
      client: () =>
        new PrismaClient({
          adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        }),
    }),
    PrismaHttpModule.forRoot(),
    UsersModule,
  ],
})
export class AppModule {}
// #endregion module
