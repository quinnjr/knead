import { describe, expect, test } from 'bun:test';
import { MemoryStore, type RateLimitRule } from '../src/index.js';

function clockStore(options: { maxKeys?: number } = {}) {
  let now = 0;
  const store = new MemoryStore({ now: () => now, sweepIntervalMs: 0, ...options });
  return {
    store,
    at: (t: number) => {
      now = t;
    },
  };
}

const sliding: RateLimitRule = { limit: 3, windowMs: 1000, algorithm: 'sliding-window' };
const bucket: RateLimitRule = { limit: 2, windowMs: 1000, algorithm: 'token-bucket' };

async function run(store: MemoryStore, key: string, rule: RateLimitRule, times: number) {
  const out = [];
  for (let i = 0; i < times; i++) out.push(await store.consume(key, rule));
  return out;
}

describe('sliding window counter', () => {
  test('allows up to the limit within a window', async () => {
    const { store } = clockStore();
    const results = await run(store, 'k', sliding, 4);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.resetAt).toBe(1000);
  });

  test('weights the previous window', async () => {
    const { store, at } = clockStore();
    await run(store, 'k', sliding, 3);
    at(1000);
    expect((await store.consume('k', sliding)).allowed).toBe(false);
    at(1600);
    const [first, second] = await run(store, 'k', sliding, 2);
    expect(first!.allowed).toBe(true);
    expect(second!.allowed).toBe(false);
    at(3000);
    expect(await store.consume('k', sliding)).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 4000,
    });
  });

  test('keys are independent', async () => {
    const { store } = clockStore();
    await run(store, 'a', sliding, 3);
    expect((await store.consume('b', sliding)).allowed).toBe(true);
  });
});

describe('token bucket', () => {
  test('refills continuously', async () => {
    const { store, at } = clockStore();
    const results = await run(store, 'k', bucket, 3);
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([1, 0, 0]);
    expect(results[2]!.resetAt).toBe(500);
    at(500);
    expect(await store.consume('k', bucket)).toMatchObject({ allowed: true, remaining: 0 });
    at(10_000);
    expect(await store.consume('k', bucket)).toMatchObject({ allowed: true, remaining: 1 });
  });
});

describe('housekeeping', () => {
  test('maxKeys evicts the least recently used key', async () => {
    const { store } = clockStore({ maxKeys: 2 });
    await run(store, 'a', sliding, 3);
    await store.consume('b', sliding);
    await store.consume('c', sliding);
    expect(store.size).toBe(2);
    expect((await store.consume('a', sliding)).remaining).toBe(2);
  });

  test('sweep drops expired entries', async () => {
    const { store, at } = clockStore();
    await store.consume('s', sliding);
    await store.consume('t', bucket);
    at(5_000);
    store.sweep();
    expect(store.size).toBe(0);
  });

  test('parallel consumption never over-admits', async () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    const rule: RateLimitRule = { limit: 10, windowMs: 60_000, algorithm: 'sliding-window' };
    const results = await Promise.all(Array.from({ length: 50 }, () => store.consume('p', rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    store.close();
  });
});
