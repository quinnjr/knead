import { afterAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { MemoryStore, type RateLimitRule, RedisStore } from '../src/index.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('RedisStore', () => {
  const prefix = `hpmws:test:${crypto.randomUUID()}:`;
  const shared = url ? new RedisClient(url) : undefined;
  afterAll(() => shared?.close());

  /** Redis server time in epoch ms (the store's clock). */
  async function redisNow(): Promise<number> {
    const [s, us] = (await shared!.send('TIME', [])) as [string, string];
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  }

  const sliding: RateLimitRule = { limit: 3, windowMs: 2_000, algorithm: 'sliding-window' };
  const bucket: RateLimitRule = { limit: 2, windowMs: 2_000, algorithm: 'token-bucket' };

  test('sliding window allows up to the limit', async () => {
    const store = new RedisStore({ client: shared, prefix });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consume('s', sliding));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[0]!.remaining).toBe(2);
    expect(results[3]!.resetAt).toBeGreaterThan(Date.now() - 5_000);
  });

  test('token bucket allows the burst then refuses', async () => {
    const store = new RedisStore({ client: shared, prefix });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await store.consume('b', bucket));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
  });

  test('rejects invalid rules before calling Redis', async () => {
    const store = new RedisStore({ client: shared, prefix });
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(store.consume('v', { ...sliding, limit })).rejects.toBeInstanceOf(RangeError);
    }
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.consume('v', { ...bucket, windowMs })).rejects.toBeInstanceOf(RangeError);
    }
  });

  test('sliding denial resetAt matches MemoryStore (next-window solve)', async () => {
    const rule: RateLimitRule = { limit: 3, windowMs: 60_000, algorithm: 'sliding-window' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const store = new RedisStore({ client: shared, prefix });
      const key = `sd-${attempt}`;
      const t0 = await redisNow();
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await store.consume(key, rule));
      const t1 = await redisNow();
      if (Math.floor(t0 / 60_000) !== Math.floor(t1 / 60_000)) continue; // window rolled mid-test
      const memory = new MemoryStore({ now: () => t0, sweepIntervalMs: 0 });
      const expected = [];
      for (let i = 0; i < 4; i++) expected.push(await memory.consume(key, rule));
      expect(results.map((r) => r.allowed)).toEqual(expected.map((r) => r.allowed));
      expect(results.map((r) => r.remaining)).toEqual(expected.map((r) => r.remaining));
      expect(results[0]!.resetAt).toBe(expected[0]!.resetAt); // success: window end
      expect(results[3]!.resetAt).toBe(expected[3]!.resetAt); // denial: ws + 2w - 2w/3
      return;
    }
    throw new Error('window rolled on every attempt');
  });

  test('sliding denial resetAt uses the in-window solve when the previous window is populated', async () => {
    const w = 60_000;
    const rule: RateLimitRule = { limit: 10, windowMs: w, algorithm: 'sliding-window' };
    const store = new RedisStore({ client: shared, prefix });
    const t0 = await redisNow();
    const ws = Math.floor(t0 / w) * w;
    // 1000 requests in the previous window: denied until the weight drops below 9/1000.
    await shared!.send('SET', [`${prefix}ip:${ws - w}`, '1000', 'PX', '120000']);
    const result = await store.consume('ip', rule);
    const t1 = await redisNow();
    if (Math.floor(t1 / w) * w !== ws) return; // window rolled mid-test
    const solve = Math.ceil(ws + w - (9 * w) / 1000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeGreaterThanOrEqual(Math.max(t0, solve));
    expect(result.resetAt).toBeLessThanOrEqual(Math.max(t1, solve));
    expect(result.resetAt).toBeLessThan(ws + w);
  });

  test('token bucket resetAt follows MemoryStore semantics relative to Redis time', async () => {
    const store = new RedisStore({ client: shared, prefix });
    const t0 = await redisNow();
    const first = await store.consume('br', bucket);
    const second = await store.consume('br', bucket);
    const denied = await store.consume('br', bucket);
    const t1 = await redisNow();
    expect([first.allowed, second.allowed, denied.allowed]).toEqual([true, true, false]);
    expect([first.remaining, second.remaining, denied.remaining]).toEqual([1, 0, 0]);
    // Success: time until full. 1 token missing at 1 token/s => about 1000ms from the call.
    expect(first.resetAt - t0).toBeGreaterThanOrEqual(900);
    expect(first.resetAt - t1).toBeLessThanOrEqual(1_000);
    // Denial: next whole token in about 1000ms (limit 2 / 2000ms), never in the past.
    expect(denied.resetAt).toBeGreaterThan(t0);
    expect(denied.resetAt - t1).toBeLessThanOrEqual(1_000);
    expect(denied.resetAt - t0).toBeGreaterThanOrEqual(900);
  });

  test('recovers when the script cache is flushed (NOSCRIPT)', async () => {
    const store = new RedisStore({ client: shared, prefix });
    await store.consume('n', sliding);
    await shared!.send('SCRIPT', ['FLUSH']);
    expect((await store.consume('n', sliding)).allowed).toBe(true);
  });

  test('two stores with separate connections never over-admit together', async () => {
    const a = new RedisStore({ url, prefix });
    const b = new RedisStore({ url, prefix });
    const rule: RateLimitRule = { limit: 10, windowMs: 60_000, algorithm: 'sliding-window' };
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).consume('shared', rule)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    await a.close();
    await b.close();
  });

  test('close() leaves injected clients open', async () => {
    const store = new RedisStore({ client: shared, prefix });
    await store.close();
    expect(await shared!.send('PING', [])).toBe('PONG');
  });
});
