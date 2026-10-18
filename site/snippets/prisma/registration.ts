import { Injectable, inject, Module } from '@knead-js/core';
import { PrismaModule } from '@knead-js/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

// #region async
@Injectable()
export class DatabaseConfig {
  readonly url = process.env.DATABASE_URL;
  readonly schema = process.env.DATABASE_SCHEMA ?? 'public';
}

@Module({ providers: [DatabaseConfig], exports: [DatabaseConfig] })
export class DatabaseConfigModule {}

@Module({
  imports: [
    PrismaModule.forRootAsync({
      imports: [DatabaseConfigModule],
      useFactory: () => {
        const config = inject(DatabaseConfig);
        return {
          client: () =>
            new PrismaClient({
              adapter: new PrismaPg({ connectionString: config.url }, { schema: config.schema }),
            }),
        };
      },
    }),
  ],
})
export class AsyncAppModule {}
// #endregion async
