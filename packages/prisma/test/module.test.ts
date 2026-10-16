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
    expect((error as KneadError).message).not.toContain('secret');
    expect((error as KneadError).cause).toBe(original);
    const entries = logger.entries.filter((e) => e.level === 'error');
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('secret');
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
