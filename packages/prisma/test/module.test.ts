import { describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  InjectionToken,
  inject,
  KneadError,
  MemoryLogger,
  Module,
} from '@knead-js/core';
import { PRISMA_CLIENT, PrismaModule, PrismaService } from '../src/index.js';
import { createFakeClient } from './fake-client.js';

describe('PrismaModule', () => {
  test('forRoot validates options eagerly', () => {
    expect(() => PrismaModule.forRoot({} as never)).toThrow(KneadError);
    expect(() => PrismaModule.forRoot({ client: 42 } as never)).toThrow(KneadError);
  });

  test('connects on init and disconnects on close (factory = owned)', async () => {
    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(PrismaModule.forRoot({ client: () => fake }));
    expect(fake.calls).toEqual(['$connect']);
    await ctx.close();
    expect(fake.calls).toEqual(['$connect', '$disconnect']);
  });

  test('an async client factory is awaited', async () => {
    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(PrismaModule.forRoot({ client: async () => fake }));
    expect(ctx.get(PrismaService).client).toBe(fake);
    await ctx.close();
  });

  test('an instance is not disconnected by default', async () => {
    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(PrismaModule.forRoot({ instance: fake }));
    await ctx.close();
    expect(fake.calls).toEqual(['$connect']);

    const owned = createFakeClient();
    const ctx2 = await ApplicationContext.create(
      PrismaModule.forRoot({ instance: owned, disconnectOnShutdown: true }),
    );
    await ctx2.close();
    expect(owned.calls).toEqual(['$connect', '$disconnect']);
  });

  test('connect failure aborts bootstrap with a redacted KneadError', async () => {
    const original = new Error('connect to postgres://u:secret@db failed');
    const fake = createFakeClient({ connectError: original });
    const logger = new MemoryLogger();
    const error = await ApplicationContext.create(PrismaModule.forRoot({ client: () => fake }), {
      logger,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KneadError);
    expect((error as KneadError).message).toBe('Prisma failed to connect to the database');
    expect((error as KneadError).cause).toBe(original);
    const entries = logger.entries.filter((e) => e.level === 'error');
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  test('in production the connect-failure log has only the error name and code', async () => {
    const original = Object.assign(new Error('connect to postgres://u:secret@db failed'), {
      name: 'PrismaClientInitializationError',
      errorCode: 'P1001',
    });
    const logger = new MemoryLogger();
    await expect(
      ApplicationContext.create(
        PrismaModule.forRoot({ client: () => createFakeClient({ connectError: original }) }),
        { logger, development: false },
      ),
    ).rejects.toBeInstanceOf(KneadError);
    const entries = logger.entries.filter((e) => e.level === 'error');
    expect(entries).toHaveLength(1);
    const text = JSON.stringify(entries);
    expect(text).toContain('PrismaClientInitializationError');
    expect(text).toContain('P1001');
    expect(text).not.toContain('connect to');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('secret');
    expect(entries[0]?.meta).toEqual([]);
  });

  test('in development the connect-failure log has the full redacted error', async () => {
    const original = Object.assign(new Error('connect to postgres://u:secret@db failed'), {
      code: 'ECONNREFUSED',
    });
    const logger = new MemoryLogger();
    await expect(
      ApplicationContext.create(
        PrismaModule.forRoot({ client: () => createFakeClient({ connectError: original }) }),
        { logger, development: true },
      ),
    ).rejects.toBeInstanceOf(KneadError);
    const entries = logger.entries.filter((e) => e.level === 'error');
    expect(entries).toHaveLength(1);
    const text = JSON.stringify(entries);
    expect(text).toContain('connect to postgres://***@db failed');
    expect(text).not.toContain('secret');
  });

  test('an unusual error name or code is left out of the production log', async () => {
    const original = Object.assign(new Error('x'), {
      name: 'Bad name postgres://u:secret@db',
      code: { nested: 'secret' },
    });
    const logger = new MemoryLogger();
    await ApplicationContext.create(
      PrismaModule.forRoot({ client: () => createFakeClient({ connectError: original }) }),
      { logger, development: false },
    ).catch(() => {});
    const text = JSON.stringify(logger.entries);
    expect(text).not.toContain('secret');
    expect(text).toContain('Prisma failed to connect');
  });

  test('a failed connect disconnects an owned client but not an instance', async () => {
    const owned = createFakeClient({ connectError: new Error('boom') });
    await expect(
      ApplicationContext.create(PrismaModule.forRoot({ client: () => owned })),
    ).rejects.toBeInstanceOf(KneadError);
    expect(owned.calls).toEqual(['$connect', '$disconnect']);

    const borrowed = createFakeClient({ connectError: new Error('boom') });
    await expect(
      ApplicationContext.create(PrismaModule.forRoot({ instance: borrowed })),
    ).rejects.toBeInstanceOf(KneadError);
    expect(borrowed.calls).toEqual(['$connect']);
  });

  test('a failing disconnect during cleanup does not mask the connect error', async () => {
    const fake = createFakeClient({ connectError: new Error('boom') });
    fake.$disconnect = async () => {
      throw new Error('disconnect failed');
    };
    const error = await ApplicationContext.create(
      PrismaModule.forRoot({ client: () => fake }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as KneadError).message).toBe('Prisma failed to connect to the database');
  });

  test('an invalid client shape is a KneadError', async () => {
    expect(() => PrismaModule.forRoot({ instance: {} } as never)).toThrow(KneadError);
    for (const bad of [undefined, {}, { $connect() {}, $disconnect() {} }]) {
      await expect(
        ApplicationContext.create(PrismaModule.forRoot({ client: () => bad } as never)),
      ).rejects.toBeInstanceOf(KneadError);
    }
  });

  test('client: undefined next to an instance uses the instance', async () => {
    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(
      PrismaModule.forRoot({ client: undefined, instance: fake } as never),
    );
    expect(ctx.get(PrismaService).client).toBe(fake);
    await ctx.close();
    expect(fake.calls).toEqual(['$connect']);
  });

  test('forRootAsync resolves options via inject()', async () => {
    const fake = createFakeClient();
    const CLIENT = new InjectionToken<typeof fake>('test:client');
    @Module({ providers: [{ provide: CLIENT, useValue: fake }], exports: [CLIENT] })
    class ConfigModule {}
    const ctx = await ApplicationContext.create(
      PrismaModule.forRootAsync({
        imports: [ConfigModule],
        useFactory: () => {
          const client = inject(CLIENT);
          return { client: () => client };
        },
      }),
    );
    expect(ctx.get(PrismaService).client).toBe(fake);
    await ctx.close();
  });

  test('forRootAsync validates the resolved options', async () => {
    await expect(
      ApplicationContext.create(PrismaModule.forRootAsync({ useFactory: () => ({}) as never })),
    ).rejects.toBeInstanceOf(KneadError);
  });

  test('PRISMA_CLIENT and PrismaService.client are the same object', async () => {
    const fake = createFakeClient();
    const ctx = await ApplicationContext.create(PrismaModule.forRoot({ client: () => fake }));
    expect(ctx.get(PRISMA_CLIENT)).toBe(ctx.get(PrismaService).client);
    expect(ctx.get(PRISMA_CLIENT)).toBe(fake);
    await ctx.close();
  });
});
