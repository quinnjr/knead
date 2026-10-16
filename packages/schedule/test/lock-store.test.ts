import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { MemoryLockStore, ScheduleConfigError } from '../src/index.js';

afterEach(() => {
  setSystemTime();
});

test('one caller per key until the TTL passes', async () => {
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const store = new MemoryLockStore();
  expect(await store.acquire('a', 1_000)).toBe(true);
  expect(await store.acquire('a', 1_000)).toBe(false);
  expect(await store.acquire('b', 1_000)).toBe(true);
  setSystemTime(new Date('2026-01-01T00:00:00.999Z'));
  expect(await store.acquire('a', 1_000)).toBe(false);
  setSystemTime(new Date('2026-01-01T00:00:01Z'));
  expect(await store.acquire('a', 1_000)).toBe(true);
});

test('expired locks are swept so the map does not grow without bound', async () => {
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const store = new MemoryLockStore();
  for (let i = 0; i < 200; i++) await store.acquire(`k${i}`, 10);
  setSystemTime(new Date('2026-01-01T00:00:01Z'));
  for (let i = 0; i < 56; i++) await store.acquire(`fresh${i}`, 10_000);
  expect(store.size).toBe(56);
});

test('the TTL must be a positive integer', async () => {
  const store = new MemoryLockStore();
  for (const ttl of [0, -1, 1.5, Number.NaN]) {
    await expect(store.acquire('a', ttl)).rejects.toThrow(ScheduleConfigError);
  }
});
