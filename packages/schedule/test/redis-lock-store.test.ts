import { afterAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { RedisLockStore } from '../src/index.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('RedisLockStore', () => {
  const prefix = `knead:test:${crypto.randomUUID()}:`;
  const shared = url ? new RedisClient(url) : undefined;
  afterAll(() => shared?.close());

  test('one instance wins each key; others lose until the TTL expires', async () => {
    const a = new RedisLockStore({ client: shared, prefix });
    const b = new RedisLockStore({ url, prefix });
    try {
      const results = await Promise.all([a.acquire('job:1', 200), b.acquire('job:1', 200)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await a.acquire('job:2', 200)).toBe(true);
      await Bun.sleep(250);
      expect(await b.acquire('job:1', 200)).toBe(true);
    } finally {
      await b.close();
    }
  });

  test('keys carry the TTL', async () => {
    const store = new RedisLockStore({ client: shared, prefix });
    await store.acquire('ttl', 60_000);
    const pttl = Number(await shared!.send('PTTL', [`${prefix}ttl`]));
    expect(pttl).toBeGreaterThan(59_000);
    expect(pttl).toBeLessThanOrEqual(60_000);
  });
});
