import { describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  InjectionContextError,
  inject,
  KneadError,
  MemoryLogger,
  Module,
} from '@knead-js/core';
import { PrismaModule, PrismaService, Transactional, TransactionHost } from '../src/index.js';
import { createFakeClient } from './fake-client.js';

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(options: { development?: boolean; logger?: MemoryLogger } = {}) {
  const fake = createFakeClient();
  const ctx = await ApplicationContext.create(PrismaModule.forRoot({ client: () => fake }), {
    development: options.development ?? false,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { fake, ctx, host: ctx.get(TransactionHost), prisma: ctx.get(PrismaService) };
}

function txId(prisma: PrismaService): number {
  return (prisma.db as unknown as { id: number }).id;
}

describe('TransactionHost', () => {
  test('db is the base client outside run and the tx inside', async () => {
    const { fake, ctx, host, prisma } = await setup();
    expect(prisma.db).toBe(fake);
    expect(host.isActive).toBe(false);
    await host.run(async () => {
      expect(host.isActive).toBe(true);
      expect(prisma.db).toBe(fake.transactions[0]?.tx as never);
    });
    expect(prisma.db).toBe(fake);
    await ctx.close();
  });

  test('commits on resolve, rolls back on reject and rethrows the same error', async () => {
    const { fake, ctx, host } = await setup();
    expect(await host.run(async () => 42)).toBe(42);
    const err = new Error('boom');
    await expect(
      host.run(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['commit', 'rollback']);
    await ctx.close();
  });

  test('rethrows non-Error values', async () => {
    const { fake, ctx, host } = await setup();
    for (const value of ['x', null]) {
      const caught = await host
        .run(async () => {
          throw value;
        })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      expect(caught).toBe(value);
    }
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['rollback', 'rollback']);
    await ctx.close();
  });

  test('nested required joins', async () => {
    const { fake, ctx, host, prisma } = await setup();
    await host.run(async () => {
      const outer = txId(prisma);
      await host.run(async () => {
        expect(txId(prisma)).toBe(outer);
      });
    });
    expect(fake.calls.filter((c) => c === '$transaction')).toHaveLength(1);
    await ctx.close();
  });

  test('an inner joined failure marks the transaction rollback-only', async () => {
    const { fake, ctx, host } = await setup();
    const inner = new Error('inner');
    const error = await host
      .run(async () => {
        await host.run(async () => {
          throw inner;
        }).catch(() => {});
        return 'swallowed';
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(KneadError);
    expect((error as KneadError).message).toContain(
      'transaction marked rollback-only by an inner failure',
    );
    expect((error as KneadError).cause).toBe(inner);
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['rollback']);
    await ctx.close();
  });

  test('an inner joined failure rethrows the inner error unchanged', async () => {
    const { ctx, host } = await setup();
    const inner = new Error('inner');
    let seen: unknown;
    await host
      .run(async () => {
        seen = await host
          .run(async () => {
            throw inner;
          })
          .catch((e: unknown) => e);
      })
      .catch(() => {});
    expect(seen).toBe(inner);
    await ctx.close();
  });

  test("the owner's own rejection wins over rollback-only", async () => {
    const { fake, ctx, host } = await setup();
    const outer = new Error('outer');
    await expect(
      host.run(async () => {
        await host
          .run(async () => {
            throw new Error('inner');
          })
          .catch(() => {});
        throw outer;
      }),
    ).rejects.toBe(outer);
    expect(fake.transactions[0]?.outcome).toBe('rollback');
    await ctx.close();
  });

  test('a failing requiresNew run does not mark the outer transaction', async () => {
    const { fake, ctx, host } = await setup();
    const value = await host.run(async () => {
      await host
        .run(
          async () => {
            throw new Error('inner');
          },
          { propagation: 'requiresNew' },
        )
        .catch(() => {});
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['commit', 'rollback']);
    await ctx.close();
  });

  test('requiresNew opens a separate transaction and restores the outer frame', async () => {
    const { fake, ctx, host, prisma } = await setup();
    await host.run(async () => {
      const outer = txId(prisma);
      await host.run(
        async () => {
          expect(txId(prisma)).not.toBe(outer);
        },
        { propagation: 'requiresNew' },
      );
      expect(txId(prisma)).toBe(outer);
    });
    expect(fake.transactions).toHaveLength(2);
    await ctx.close();
  });

  test('passes only the transaction options that are set', async () => {
    const { fake, ctx, host } = await setup();
    await host.run(async () => {});
    await host.run(async () => {}, {
      isolationLevel: 'Serializable',
      timeout: 10,
      maxWait: 5,
      propagation: 'requiresNew',
    });
    expect(fake.transactions[0]?.options).toEqual({});
    expect(fake.transactions[1]?.options).toEqual({
      isolationLevel: 'Serializable',
      timeout: 10,
      maxWait: 5,
    });
    await ctx.close();
  });

  test('joining with different options warns in development only', async () => {
    for (const development of [true, false]) {
      const logger = new MemoryLogger();
      const { ctx, host } = await setup({ development, logger });
      await host.run(
        async () => {
          await host.run(async () => {}, { isolationLevel: 'Serializable' });
          await host.run(async () => {}, { isolationLevel: 'ReadCommitted' });
        },
        { isolationLevel: 'ReadCommitted' },
      );
      const warnings = logger.entries.filter((e) => e.level === 'warn');
      expect(warnings).toHaveLength(development ? 1 : 0);
      await ctx.close();
    }
  });

  test('no leakage after run settles', async () => {
    const { fake, ctx, host, prisma } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<{ active: boolean; db: unknown }> | undefined;
    await host.run(async () => {
      late = gate.then(() => ({ active: host.isActive, db: prisma.db }));
    });
    expect(host.isActive).toBe(false);
    release();
    const seen = await late;
    expect(seen?.active).toBe(false);
    // It still sees the (closed) transaction, so Prisma fails loudly instead of silently
    // writing outside it.
    expect(seen?.db).toBe(fake.transactions[0]?.tx as never);
    await ctx.close();
  });

  test('run after the frame has settled opens a new transaction', async () => {
    const { fake, ctx, host } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<void> | undefined;
    await host.run(async () => {
      late = gate.then(() => host.run(async () => {}));
    });
    release();
    await late;
    expect(fake.transactions).toHaveLength(2);
    await ctx.close();
  });

  test('isolates concurrent runs', async () => {
    const { ctx, host, prisma } = await setup();
    const seen: Array<[number, number]> = [];
    await Promise.all(
      [3, 1].map((ms) =>
        host.run(async () => {
          const before = txId(prisma);
          await tick(ms);
          seen.push([before, txId(prisma)]);
        }),
      ),
    );
    expect(seen).toHaveLength(2);
    for (const [before, after] of seen) expect(after).toBe(before);
    expect(new Set(seen.map(([id]) => id)).size).toBe(2);
    await ctx.close();
  });

  test('two applications in one process do not share transactions', async () => {
    const a = await setup();
    const b = await setup();
    await a.host.run(async () => {
      expect(a.host.isActive).toBe(true);
      expect(b.host.isActive).toBe(false);
      expect(b.prisma.db).toBe(b.fake);
    });
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('@Transactional', () => {
  test('@Transactional wraps the method in run', async () => {
    class Users {
      readonly host = inject(TransactionHost);

      @Transactional({ isolationLevel: 'Serializable' })
      async create(value: number): Promise<{ active: boolean; self: Users; value: number }> {
        return { active: this.host.isActive, self: this, value };
      }
    }
    @Module({ providers: [Users] })
    class AppModule {}

    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(
      { module: AppModule, imports: [PrismaModule.forRoot({ client: () => fake })] },
      { development: false },
    );
    const users = ctx.get(Users);
    const result = await users.create(7);
    expect(result).toEqual({ active: true, self: users, value: 7 });
    expect(result.self).toBe(users);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.options).toEqual({ isolationLevel: 'Serializable' });
    await ctx.close();
  });

  test('@Transactional on a class built with new throws InjectionContextError at construction', () => {
    class Plain {
      @Transactional()
      async work(): Promise<void> {}
    }
    expect(() => new Plain()).toThrow(InjectionContextError);
  });
});
