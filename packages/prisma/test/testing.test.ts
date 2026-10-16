import { describe, expect, test } from 'bun:test';
import { Test } from '@knead-js/testing';
import { PrismaModule } from '../src/index.js';
import { withRollback } from '../src/testing/index.js';
import { createFakeClient } from './fake-client.js';

async function setup() {
  const fake = createFakeClient();
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
});
