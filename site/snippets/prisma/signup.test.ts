import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PrismaModule } from '@knead-js/prisma';
import { withRollback } from '@knead-js/prisma/testing';
import { Test, type TestingModule } from '@knead-js/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { AuditLog, OrdersRepository, UsersRepository } from './users.repository.js';
import { SignupService } from './users.service.js';

// #region rollback
// A disposable database: never point tests at DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(url === undefined)('SignupService', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createModule({
      imports: [
        PrismaModule.forRoot({
          client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
        }),
      ],
      providers: [UsersRepository, OrdersRepository, AuditLog, SignupService],
    }).compile();
  });

  afterAll(() => moduleRef.close());

  test('signs a user up', async () => {
    await withRollback(moduleRef, async () => {
      const user = await moduleRef.get(SignupService).signUp({
        email: 'ada@example.com',
        name: 'Ada',
        firstOrderTotal: 1200,
      });
      expect(await moduleRef.get(UsersRepository).findById(user.id)).toEqual(user);
    });
    // Rolled back: nothing persists.
  });
});
// #endregion rollback
