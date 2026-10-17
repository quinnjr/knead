// Pins the behaviour documented on guide/database and packages/prisma, with an in-memory fake in
// place of a database (PRISMA_CLIENT overridden).
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  InjectionContextError,
  KneadError,
  MemoryLogger,
  Module,
} from '@knead-js/core';
import { Controller, Get } from '@knead-js/http';
import {
  PRISMA_CLIENT,
  PrismaModule,
  PrismaService,
  Transactional,
  TransactionHost,
} from '@knead-js/prisma';
import { isPrismaError, PrismaHttpModule, toHttpException } from '@knead-js/prisma/http';
import { withRollback } from '@knead-js/prisma/testing';
import { Test, type TestingModule } from '@knead-js/testing';
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
  PrismaClientRustPanicError,
  PrismaClientUnknownRequestError,
  PrismaClientValidationError,
} from '@prisma/client/runtime/client';
import { AppModule } from '../snippets/prisma/app.module.js';
import type {
  AuditEntry,
  Order,
  PrismaClient,
  TransactionClient,
  User,
} from '../snippets/prisma/generated/prisma/client.js';
import { PrismaErrorsModule } from '../snippets/prisma/http-errors.js';
import { AsyncAppModule } from '../snippets/prisma/registration.js';
import { UsersModule } from '../snippets/prisma/users.module.js';
import { UsersRepository } from '../snippets/prisma/users.repository.js';
import { ImportService, SignupService } from '../snippets/prisma/users.service.js';

const clientVersion = '7.9.1';

const known = (code: string, meta?: Record<string, unknown>) =>
  new PrismaClientKnownRequestError('Query failed: postgres://app:s3cret@db/app', {
    code,
    clientVersion,
    meta,
  });

interface Fake {
  client: PrismaClient;
  calls: string[];
  transactions: { options: unknown; outcome?: 'commit' | 'rollback' }[];
  state: { users: User[]; orders: Order[]; audit: AuditEntry[] };
}

/** A recording in-memory client. Rolling back restores the state from before the transaction. */
function createFake(opts: { connectError?: Error; swallowRollback?: boolean } = {}): Fake {
  const state: Fake['state'] = { users: [], orders: [], audit: [] };
  const calls: string[] = [];
  const transactions: Fake['transactions'] = [];
  let nextId = 1;
  const tx: TransactionClient = {
    user: {
      findUnique: async ({ where }) =>
        state.users.find((u) => ('id' in where ? u.id === where.id : u.email === where.email)) ??
        null,
      create: async ({ data }) => {
        if (state.users.some((u) => u.email === data.email)) {
          throw known('P2002', { modelName: 'User', target: ['email'] });
        }
        const user = { id: nextId++, email: data.email, name: data.name ?? null };
        state.users = [...state.users, user];
        return user;
      },
      count: async () => state.users.length,
    },
    order: {
      create: async ({ data }) => {
        if (!state.users.some((u) => u.id === data.userId)) throw known('P2003');
        const order = { id: nextId++, ...data };
        state.orders = [...state.orders, order];
        return order;
      },
    },
    auditEntry: {
      create: async ({ data }) => {
        const entry = { id: nextId++, ...data };
        state.audit = [...state.audit, entry];
        return entry;
      },
    },
  };
  const client: PrismaClient = {
    ...tx,
    $connect: async () => {
      calls.push('$connect');
      if (opts.connectError) throw opts.connectError;
    },
    $disconnect: async () => {
      calls.push('$disconnect');
    },
    $on: () => {},
    $transaction: async (fn, options) => {
      const record: Fake['transactions'][number] = { options };
      transactions.push(record);
      const before = { ...state };
      try {
        const result = await fn(tx);
        record.outcome = 'commit';
        return result;
      } catch (error) {
        Object.assign(state, before);
        record.outcome = 'rollback';
        if (opts.swallowRollback) return undefined as never;
        throw error;
      }
    },
  };
  return { client, calls, transactions, state };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const ctx of open.splice(0)) await ctx.close();
});

async function appWith(fake: Fake, development = false): Promise<TestingModule> {
  const moduleRef = await Test.createModule({ imports: [AppModule] })
    .overrideProvider(PRISMA_CLIENT)
    .useValue(fake.client)
    .compile({ development });
  open.push(moduleRef);
  return moduleRef;
}

const signUp = { email: 'ada@example.com', name: 'Ada', firstOrderTotal: 1200 };

describe('the example app', () => {
  test('connects at bootstrap and disconnects the client it owns on close', async () => {
    const fake = createFake();
    const moduleRef = await appWith(fake);
    expect(fake.calls).toEqual(['$connect']);
    await moduleRef.close();
    expect(fake.calls).toEqual(['$connect', '$disconnect']);
  });

  test('POST /users signs up in one transaction', async () => {
    const fake = createFake();
    const app = await (await appWith(fake)).createApp();
    const res = await app.request('POST', '/users', { json: signUp });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, email: 'ada@example.com', name: 'Ada' });
    expect(fake.transactions).toEqual([{ options: {}, outcome: 'commit' }]);
    expect(fake.state.orders).toHaveLength(1);
    expect(fake.state.audit).toEqual([{ id: 3, action: 'user.created:1' }]);
    const found = await app.request('GET', '/users/1');
    expect(await found.json()).toEqual({ id: 1, email: 'ada@example.com', name: 'Ada' });
  });

  test('a duplicate email is a 409 problem response and nothing is written', async () => {
    const fake = createFake();
    const moduleRef = await appWith(fake);
    const app = await moduleRef.createApp();
    await app.request('POST', '/users', { json: signUp });
    const res = await app.request('POST', '/users', { json: signUp });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'A record with these values already exists.',
      instance: '/users',
    });
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['commit', 'rollback']);
    expect(fake.state.users).toHaveLength(1);
    expect(JSON.stringify(moduleRef.logs)).not.toContain('s3cret');
  });

  test('in development the problem adds prismaCode and the constraint fields', async () => {
    const app = await (await appWith(createFake(), true)).createApp();
    await app.request('POST', '/users', { json: signUp });
    const res = await app.request('POST', '/users', { json: signUp });
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'A record with these values already exists.',
      instance: '/users',
      prismaCode: 'P2002',
      fields: ['email'],
    });
  });
});

describe('error mapping', () => {
  const cases: [string, unknown, number, string | undefined][] = [
    ['P2002', known('P2002'), 409, 'A record with these values already exists.'],
    ['P2003', known('P2003'), 409, 'The operation conflicts with a related record.'],
    ['P2025', known('P2025'), 404, 'The requested record was not found.'],
    ['P2000', known('P2000'), 400, 'A value is too long for its field.'],
    [
      'validation',
      new PrismaClientValidationError('Argument `email` is missing.', { clientVersion }),
      400,
      'The request could not be processed.',
    ],
    ['P1001', known('P1001'), 503, 'The database is temporarily unavailable.'],
    ['P1002', known('P1002'), 503, 'The database is temporarily unavailable.'],
    ['P2024', known('P2024'), 503, 'The database is temporarily unavailable.'],
    [
      'initialization',
      new PrismaClientInitializationError('Cannot reach db:5432', clientVersion, 'P1001'),
      503,
      'The database is temporarily unavailable.',
    ],
    ['other code', known('P2034'), 500, undefined],
    [
      'unknown request',
      new PrismaClientUnknownRequestError('?', { clientVersion }),
      500,
      undefined,
    ],
    ['rust panic', new PrismaClientRustPanicError('panic', clientVersion), 500, undefined],
  ];
  for (const [label, error, status, detail] of cases) {
    test(`${label} maps to ${status}`, () => {
      expect(isPrismaError(error)).toBe(true);
      const exception = toHttpException(error)!;
      expect([exception.status, exception.detail]).toEqual([status, detail]);
      expect(exception.cause).toBe(error);
    });
  }

  test('non-Prisma errors are declined', () => {
    expect(toHttpException(new Error('x'))).toBeUndefined();
    expect(isPrismaError({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBe(true);
  });

  @Controller('/health')
  class HealthController {
    @Get('/')
    check(): never {
      throw known(process.env.KNEAD_DOCS_PRISMA_CODE ?? 'P1001');
    }
  }

  async function health(code: string, development: boolean, modules: Function[] = []) {
    process.env.KNEAD_DOCS_PRISMA_CODE = code;
    const moduleRef = await Test.createModule({
      imports: modules.length > 0 ? (modules as never[]) : [PrismaHttpModule.forRoot()],
      controllers: [HealthController],
    }).compile({ development });
    open.push(moduleRef);
    const res = await (await moduleRef.createApp()).request('GET', '/health');
    return { res, body: (await res.json()) as Record<string, unknown>, moduleRef };
  }

  test('outside development a 503 keeps only type, title, status, instance and correlationId', async () => {
    const { res, body, moduleRef } = await health('P1001', false);
    expect(res.status).toBe(503);
    expect(Object.keys(body).sort()).toEqual([
      'correlationId',
      'instance',
      'status',
      'title',
      'type',
    ]);
    expect(JSON.stringify(moduleRef.logs)).not.toContain('s3cret');
  });

  test('in development a 503 carries the fixed detail', async () => {
    const { body } = await health('P1001', true);
    expect(body.detail).toBe('The database is temporarily unavailable.');
    expect(body.prismaCode).toBe('P1001');
  });

  test('a custom mapper answers P2034; outside development its 5xx detail is dropped', async () => {
    const prod = await health('P2034', false, [PrismaErrorsModule]);
    expect(prod.res.status).toBe(503);
    expect(prod.res.headers.get('retry-after')).toBe('1');
    expect(prod.body.detail).toBeUndefined();
    const dev = await health('P2034', true, [PrismaErrorsModule]);
    expect(dev.body.detail).toBe('Retry the request.');
  });

  test('a mapper that throws becomes a masked 500', () => {
    const exception = toHttpException(known('P2002'), {
      map: {
        P2002: () => {
          throw new Error('bug');
        },
      },
    });
    expect([exception?.status, exception?.detail]).toEqual([500, undefined]);
  });

  test('map must be a plain object of functions', () => {
    expect(() => PrismaHttpModule.forRoot({ map: { P2002: 'nope' } as never })).toThrow(
      'PrismaHttpModule `map.P2002` must be a function.',
    );
    expect(() => PrismaHttpModule.forRoot({ map: new Map() as never })).toThrow(
      'PrismaHttpModule `map` must be a plain object of mapper functions.',
    );
  });
});

describe('transactions', () => {
  async function context(fake = createFake(), options: { development?: boolean } = {}) {
    const logger = new MemoryLogger();
    @Module({
      imports: [PrismaModule.forRoot({ instance: fake.client }), UsersModule],
    })
    class Root {}
    const ctx = await ApplicationContext.create(Root, { logger, ...options });
    open.push(ctx);
    return { ctx, fake, logger, host: ctx.get(TransactionHost) };
  }

  test('db is the transaction client inside run and the base client outside', async () => {
    const { ctx, host, fake } = await context();
    const prisma = ctx.get(PrismaService);
    expect(prisma.db).toBe(fake.client);
    expect(host.isActive).toBe(false);
    await host.run(async () => {
      expect(prisma.db).not.toBe(fake.client);
      expect(host.isActive).toBe(true);
    });
  });

  test('run passes the transaction options to $transaction', async () => {
    const { ctx, fake } = await context();
    expect(await ctx.get(ImportService).importUsers(['a@example.com', 'b@example.com'])).toBe(2);
    expect(fake.transactions).toEqual([
      {
        options: { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 2_000 },
        outcome: 'commit',
      },
    ]);
  });

  test('requiresNew opens a separate transaction that commits on its own', async () => {
    const { ctx, host, fake } = await context();
    const imports = ctx.get(ImportService);
    const boom = new Error('import failed');
    await expect(
      host.run(async () => {
        await imports.recordAttempt('import.started');
        throw boom;
      }),
    ).rejects.toBe(boom);
    // In the order they started: the outer one rolled back, the inner one committed.
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['rollback', 'commit']);
  });

  test('a caught failure of a joined run still rolls the transaction back', async () => {
    const { ctx, host, fake } = await context();
    const users = ctx.get(UsersRepository);
    const inner = new Error('inner');
    const error = await host
      .run(async () => {
        await users.create('a@example.com', null);
        await host
          .run(async () => {
            throw inner;
          })
          .catch(() => {});
        return 'done';
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KneadError);
    expect((error as KneadError).message).toBe(
      'TransactionHost: transaction marked rollback-only by an inner failure',
    );
    expect((error as KneadError).cause).toBe(inner);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.state.users).toEqual([]);
  });

  test('joining with different options warns in development', async () => {
    const { host, logger } = await context(createFake(), { development: true });
    await host.run(() => host.run(async () => 1, { isolationLevel: 'Serializable' }));
    expect(logger.entries.find((e) => e.level === 'warn')?.message).toBe(
      'TransactionHost: joined an active transaction with different options; the inner options are ignored',
    );
  });

  test('an unknown propagation is a KneadError', async () => {
    const { host } = await context();
    await expect(host.run(async () => 1, { propagation: 'nested' as never })).rejects.toThrow(
      `TransactionHost: unknown propagation "nested"; use 'required' or 'requiresNew'.`,
    );
  });

  test('@Transactional rejects a class built with new and static methods', () => {
    expect(() => new SignupService()).toThrow(InjectionContextError);
    expect(() => {
      class Jobs {
        @Transactional()
        static async run() {}
      }
      return Jobs;
    }).toThrow('@Transactional cannot decorate static methods');
  });

  test('a failing @Transactional method rolls back', async () => {
    const { ctx, fake } = await context();
    const signup = ctx.get(SignupService);
    await signup.signUp(signUp);
    await expect(signup.signUp(signUp)).rejects.toBeInstanceOf(PrismaClientKnownRequestError);
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['commit', 'rollback']);
    expect(fake.state.users).toHaveLength(1);
  });
});

describe('module', () => {
  test('forRoot validates its options', () => {
    expect(() => PrismaModule.forRoot({} as never)).toThrow(
      'PrismaModule options need exactly one of `client` or `instance`.',
    );
    expect(() => PrismaModule.forRoot({ instance: {} as never })).toThrow(
      'PrismaModule client must be a Prisma client with a $connect() method.',
    );
    expect(() =>
      PrismaModule.forRoot({ instance: createFake().client, disconnectOnShutdown: 1 as never }),
    ).toThrow('PrismaModule `disconnectOnShutdown` must be a boolean.');
  });

  test('an instance is connected but not disconnected unless disconnectOnShutdown is true', async () => {
    const fake = createFake();
    const ctx = await ApplicationContext.create(PrismaModule.forRoot({ instance: fake.client }));
    await ctx.close();
    expect(fake.calls).toEqual(['$connect']);
  });

  test('a failed connect aborts bootstrap; production logs only name and code', async () => {
    const logger = new MemoryLogger();
    const cause = new PrismaClientInitializationError(
      "Can't reach database server at postgres://app:s3cret@db:5432",
      clientVersion,
      'P1001',
    );
    const fake = createFake({ connectError: cause });
    const error = await ApplicationContext.create(
      PrismaModule.forRoot({ client: () => fake.client }),
      { logger, development: false },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KneadError);
    expect((error as KneadError).message).toBe('Prisma failed to connect to the database');
    expect((error as KneadError).cause).toBe(cause);
    expect(logger.entries.filter((e) => e.level === 'error').map((e) => e.message)).toEqual([
      'Prisma failed to connect: PrismaClientInitializationError (P1001)',
    ]);
    // The module built this client, so it disconnects it.
    expect(fake.calls).toEqual(['$connect', '$disconnect']);
  });

  test('forRootAsync resolves its options from injected providers', async () => {
    const fake = createFake();
    const moduleRef = await Test.createModule({ imports: [AsyncAppModule] })
      .overrideProvider(PRISMA_CLIENT)
      .useValue(fake.client)
      .compile();
    open.push(moduleRef);
    expect(moduleRef.get(PrismaService).client).toBe(fake.client);
  });
});

describe('withRollback', () => {
  async function testing(fake: Fake) {
    const moduleRef = await Test.createModule({
      imports: [PrismaModule.forRoot({ instance: fake.client })],
      providers: [UsersRepository],
    }).compile();
    open.push(moduleRef);
    return moduleRef;
  }

  test('runs in a requiresNew transaction that always rolls back', async () => {
    const fake = createFake();
    const moduleRef = await testing(fake);
    const count = await withRollback(moduleRef, async () => {
      await moduleRef.get(UsersRepository).create('a@example.com', null);
      return moduleRef.get(UsersRepository).count();
    });
    expect(count).toBe(1);
    expect(fake.state.users).toEqual([]);
    expect(fake.transactions).toEqual([{ options: { timeout: 30_000 }, outcome: 'rollback' }]);
  });

  test('fails closed when the rollback cannot be confirmed', async () => {
    const moduleRef = await testing(createFake({ swallowRollback: true }));
    await expect(withRollback(moduleRef, async () => 1)).rejects.toThrow(
      'withRollback: rollback not confirmed',
    );
  });
});
