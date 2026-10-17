import { describe, expect, test } from 'bun:test';
import { KneadError } from '@knead-js/core';
import { Test } from '@knead-js/testing';
import { PrismaModule, TransactionHost } from '../src/index.js';
import { withRollback } from '../src/testing/index.js';
import { createFakeClient, type FakeClient } from './fake-client.js';

async function setup(fake = createFakeClient()) {
  const ctx = await Test.createModule({
    imports: [PrismaModule.forRoot({ instance: fake })],
  }).compile();
  return { fake, ctx };
}

describe('withRollback', () => {
  test("always rolls back and returns fn's value", async () => {
    const { fake, ctx } = await setup();
    const value = await withRollback(ctx, async () => 42);
    expect(value).toBe(42);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.transactions[0]?.outcome).toBe('rollback');
  });

  test('resolves with undefined when fn returns undefined', async () => {
    const { fake, ctx } = await setup();
    expect(await withRollback(ctx, async () => undefined)).toBeUndefined();
    expect(fake.transactions[0]?.outcome).toBe('rollback');
  });

  test("rethrows fn's own error, not the sentinel", async () => {
    const { fake, ctx } = await setup();
    const boom = new Error('boom');
    await expect(
      withRollback(ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.transactions[0]?.outcome).toBe('rollback');
  });

  test('passes timeout 30000 by default and honours an override', async () => {
    const { fake, ctx } = await setup();
    await withRollback(ctx, async () => 1);
    await withRollback(ctx, async () => 1, { timeout: 5000 });
    expect(fake.transactions[0]?.options).toMatchObject({ timeout: 30000 });
    expect(fake.transactions[1]?.options).toMatchObject({ timeout: 5000 });
  });

  test('fails closed when the client swallows the rollback', async () => {
    const fake = createFakeClient();
    (fake as FakeClient).$transaction = (async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn({});
      } catch {
        return undefined;
      }
    }) as FakeClient['$transaction'];
    const { ctx } = await setup(fake);
    await expect(withRollback(ctx, async () => 1)).rejects.toThrow(
      'withRollback: rollback not confirmed',
    );
    await expect(withRollback(ctx, async () => 1)).rejects.toBeInstanceOf(KneadError);
  });

  test('fails closed when the client never runs fn', async () => {
    const fake = createFakeClient();
    (fake as FakeClient).$transaction = (async () => undefined) as FakeClient['$transaction'];
    const { ctx } = await setup(fake);
    let ran = false;
    await expect(
      withRollback(ctx, async () => {
        ran = true;
      }),
    ).rejects.toThrow('withRollback: rollback not confirmed');
    expect(ran).toBe(false);
  });

  test('inside an ambient run it opens a separate transaction and leaves the outer one alone', async () => {
    const { fake, ctx } = await setup();
    const host = ctx.get(TransactionHost);
    const value = await host.run(async () => {
      await withRollback(ctx, async () => 'inner');
      return 'outer';
    });
    expect(value).toBe('outer');
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['commit', 'rollback']);
    expect(fake.transactions[0]?.tx).not.toBe(fake.transactions[1]?.tx);
  });
});
