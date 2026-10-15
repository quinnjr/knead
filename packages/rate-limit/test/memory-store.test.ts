import { describe, expect, mock, spyOn, test } from 'bun:test';
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
    // Denied at t=0 (previous=0, current=3, limit 3): admitted again in the next window when
    // 3 * (1000 - (t - 1000)) / 1000 + 1 <= 3, i.e. t >= 2000 - 2000/3 = 1333.33 -> 1334.
    expect(results[3]!.resetAt).toBe(1334);
    expect(results[0]!.resetAt).toBe(1000);
  });

  test('weights the previous window', async () => {
    const { store, at } = clockStore();
    await run(store, 'k', sliding, 3);
    at(1000);
    // t=1000: previous=3, current=0, weight 1 -> 4 > 3 denied. Within this window 3w + 1 <= 3
    // needs w <= 2/3, i.e. t >= 2000 - 666.67 = 1333.33 -> 1334.
    expect(await store.consume('k', sliding)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 1334,
    });
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

  test('denial resetAt is the earliest admission time', async () => {
    const { store, at } = clockStore();
    await run(store, 'k', sliding, 3);
    at(1333);
    expect((await store.consume('k', sliding)).allowed).toBe(false);
    at(1334);
    expect((await store.consume('k', sliding)).allowed).toBe(true);
  });

  test('denial inside the window with room left reports the next window start', async () => {
    const { store, at } = clockStore();
    // limit 3, previous=1 after the window turns: two admissions fit, the third is denied.
    await run(store, 'k', sliding, 1);
    at(1000);
    const results = await run(store, 'k', sliding, 3);
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    // Denied with previous=1, current=2 at t=1000. In this window 1*w + 3 <= 3 needs w <= 0, i.e.
    // t = 2000, which is not before the window end. Next window: previous'=2, 2*w' + 1 <= 3 needs
    // w' <= 1, so t = 2000.
    expect(results[2]!.resetAt).toBe(2000);
    at(1999);
    expect((await store.consume('k', sliding)).allowed).toBe(false);
    at(2000);
    expect((await store.consume('k', sliding)).allowed).toBe(true);
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

describe('token bucket resetAt', () => {
  test('denial after a partial refill reports the time of the next token', async () => {
    const { store, at } = clockStore();
    await run(store, 'k', bucket, 2);
    at(250);
    // 250ms * 2/1000 = 0.5 tokens; the next whole token needs 250 more ms.
    expect(await store.consume('k', bucket)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 500,
    });
  });

  test('success reports when the bucket is full again', async () => {
    const { store } = clockStore();
    // after one take tokens = 1 of 2; one more token takes 500ms.
    expect((await store.consume('k', bucket)).resetAt).toBe(500);
  });
});

describe('validation', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects limit %p',
    async (limit) => {
      const { store } = clockStore();
      await expect(store.consume('k', { ...sliding, limit })).rejects.toThrow(RangeError);
    },
  );

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects windowMs %p',
    async (windowMs) => {
      const { store } = clockStore();
      await expect(store.consume('k', { ...bucket, windowMs })).rejects.toThrow(RangeError);
    },
  );

  test.each([0, -1, 1.5, Number.NaN])('rejects maxKeys %p', (maxKeys) => {
    expect(() => new MemoryStore({ maxKeys, sweepIntervalMs: 0 })).toThrow(RangeError);
  });
});

describe('clock skew', () => {
  test('token bucket never over-admits when the clock steps backwards', async () => {
    const { store, at } = clockStore();
    at(1000);
    const results = [...(await run(store, 'k', bucket, 2))];
    for (const t of [0, 500, 1000, 200, 1000]) {
      at(t);
      results.push(await store.consume('k', bucket));
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect(results.every((r) => r.remaining >= 0)).toBe(true);
  });

  test('sliding window keeps the stored window when the clock steps backwards', async () => {
    const { store, at } = clockStore();
    at(1500);
    await run(store, 'k', sliding, 3);
    at(500);
    const denied = await store.consume('k', sliding);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBeGreaterThanOrEqual(500);
  });
});

describe('resetAt under clock skew and in-window admission', () => {
  test('token bucket resetAt is based on the latest observed time', async () => {
    const { store, at } = clockStore();
    at(1000);
    await run(store, 'k', bucket, 2);
    at(0);
    const denied = await store.consume('k', bucket);
    expect(denied.allowed).toBe(false);
    // Next token is due 500ms after the latest observed time (1000), never before it.
    expect(denied.resetAt).toBe(1500);
  });

  test('sliding window denial after an in-window admission with current > 0', async () => {
    const { store, at } = clockStore();
    const rule: RateLimitRule = { limit: 5, windowMs: 1000, algorithm: 'sliding-window' };
    at(0);
    await run(store, 'k', rule, 4);
    at(1000);
    expect((await store.consume('k', rule)).allowed).toBe(true); // 4 * 1 + 0 + 1 = 5
    const denied = await store.consume('k', rule); // 4 * 1 + 1 + 1 = 6 > 5
    expect(denied.allowed).toBe(false);
    // 4 * (1000 - (t - 1000)) / 1000 + 2 <= 5  =>  t >= 1250
    expect(denied.resetAt).toBe(1250);
  });
});

describe('rule changes', () => {
  test('changing the window size mid-flight resets the key', async () => {
    const { store } = clockStore();
    await run(store, 'k', sliding, 3);
    expect(await store.consume('k', { ...sliding, windowMs: 2000 })).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 2000,
    });
  });
});

describe('sweep timer', () => {
  test('is unref-ed and cleared on close', () => {
    const timer = { unref: mock(() => timer) };
    const set = spyOn(globalThis, 'setInterval').mockImplementation((() => timer) as never);
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation((() => undefined) as never);
    try {
      const store = new MemoryStore();
      expect(set).toHaveBeenCalledTimes(1);
      expect(timer.unref).toHaveBeenCalledTimes(1);
      store.close();
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
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
