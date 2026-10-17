import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { inject, KneadError } from '@knead-js/core';
import { Controller, type Ctx, Post } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import { PrismaHttpModule } from '../src/http/index.js';
import { PrismaModule, PrismaService, Transactional, TransactionHost } from '../src/index.js';
import { withRollback } from '../src/testing/index.js';
import {
  type FixtureClient,
  type FixtureDb,
  loadAdapter,
  loadClient,
} from './fixtures/load-client.js';

// Runs against a real Postgres. See `test:db` in package.json:
//   docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=knead postgres:17-alpine
//   DATABASE_URL=postgresql://postgres:knead@localhost:5433/postgres pnpm --filter @knead-js/prisma test:db
const DATABASE_URL = process.env.DATABASE_URL;

function db(prisma: PrismaService): FixtureDb {
  return prisma.db as unknown as FixtureDb;
}

class UserService {
  readonly #prisma = inject(PrismaService);

  create(email: string) {
    return db(this.#prisma).user.create({ data: { email } });
  }
}

class PostService {
  readonly #prisma = inject(PrismaService);

  create(authorId: number) {
    return db(this.#prisma).post.create({ data: { authorId } });
  }
}

class SignupService {
  readonly #users = inject(UserService);
  readonly #posts = inject(PostService);

  @Transactional()
  async signUpThenFail(email: string): Promise<never> {
    const user = await this.#users.create(email);
    await this.#posts.create(user.id);
    throw new Error('abort sign-up');
  }
}

interface SignUp {
  email: string;
}

/** Passes the body through; the test controls what it sends. */
const signUpBody = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value: value as SignUp }),
    types: undefined as unknown as { input: unknown; output: SignUp },
  },
};

@Controller('/users')
class UsersController {
  readonly #users = inject(UserService);

  @Post('/', { body: signUpBody })
  create({ body }: Ctx<{ body: SignUp }>) {
    return this.#users.create(body.email);
  }
}

describe.skipIf(!DATABASE_URL)('postgres integration', () => {
  let mod: TestingModule;
  let client: FixtureClient;
  let host: TransactionHost;
  let users: UserService;

  beforeAll(async () => {
    const PrismaClient = await loadClient();
    const adapter = await loadAdapter(DATABASE_URL!);
    mod = await Test.createModule({
      imports: [
        PrismaModule.forRoot({ client: () => new PrismaClient({ adapter }) as never }),
        PrismaHttpModule.forRoot(),
      ],
      providers: [UserService, PostService, SignupService],
      controllers: [UsersController],
    }).compile({ development: false });
    client = mod.get(PrismaService).client as unknown as FixtureClient;
    host = mod.get(TransactionHost);
    users = mod.get(UserService);
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await client.post.deleteMany();
    await client.user.deleteMany();
  });

  test('commits', async () => {
    await host.run(() => users.create('commit@example.test'));
    expect(await client.user.count()).toBe(1);
  });

  test('rolls back on throw', async () => {
    const boom = new Error('boom');
    await expect(
      host.run(async () => {
        await users.create('rollback@example.test');
        expect(await client.user.count()).toBe(0); // not visible outside the transaction
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await client.user.count()).toBe(0);
  });

  test('ambient transaction across two services', async () => {
    await expect(mod.get(SignupService).signUpThenFail('ambient@example.test')).rejects.toThrow(
      'abort sign-up',
    );
    expect(await client.user.count()).toBe(0);
    expect(await client.post.count()).toBe(0);
  });

  test('an inner joined failure rolls back the whole transaction', async () => {
    const error = await host
      .run(async () => {
        await users.create('owner@example.test');
        await host
          .run(async () => {
            await users.create('inner-fail@example.test');
            throw new Error('inner fails');
          })
          .catch(() => {});
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(KneadError);
    expect(await client.user.count()).toBe(0);
  });

  test('requiresNew survives an outer rollback', async () => {
    const boom = new Error('outer fails');
    await expect(
      host.run(async () => {
        await users.create('outer@example.test');
        await host.run(() => users.create('inner@example.test'), { propagation: 'requiresNew' });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await client.user.count({ where: { email: 'inner@example.test' } })).toBe(1);
    expect(await client.user.count({ where: { email: 'outer@example.test' } })).toBe(0);
  });

  test('P2002 becomes 409 through a real server', async () => {
    const app = await mod.createApp();
    const email = 'duplicate-value@example.test';
    const first = await app.request('POST', '/users', { json: { email } });
    expect(first.ok).toBe(true);
    const second = await app.request('POST', '/users', { json: { email } });
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/problem+json');
    const text = await second.text();
    expect(text).not.toContain(email);
    expect(text).not.toContain('duplicate-value');
    expect(await client.user.count()).toBe(1);
  });

  test('P2002 carries the field names in development', async () => {
    const PrismaClient = await loadClient();
    const adapter = await loadAdapter(DATABASE_URL!);
    const dev = await Test.createModule({
      imports: [
        PrismaModule.forRoot({ client: () => new PrismaClient({ adapter }) as never }),
        PrismaHttpModule.forRoot(),
      ],
      providers: [UserService],
      controllers: [UsersController],
    }).compile({ development: true });
    try {
      const app = await dev.createApp();
      const email = 'dev-duplicate@example.test';
      expect((await app.request('POST', '/users', { json: { email } })).ok).toBe(true);
      const second = await app.request('POST', '/users', { json: { email } });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { fields?: unknown; prismaCode?: unknown };
      expect(body.prismaCode).toBe('P2002');
      expect(body.fields).toEqual(['email']);
    } finally {
      await dev.close();
    }
  });

  test('withRollback isolates', async () => {
    const created = await withRollback(mod, async () => {
      const user = await users.create('isolated@example.test');
      expect(await db(mod.get(PrismaService)).user.count()).toBe(1);
      return user;
    });
    expect(created.email).toBe('isolated@example.test');
    expect(await client.user.count()).toBe(0);
  });
});
