import { describe, expect, mock, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { RedisLockStore, ScheduleConfigError } from '../src/index.js';

describe('RedisLockStore plaintext guardrails', () => {
  test('warns about plaintext redis:// to a non-loopback host, without leaking credentials', async () => {
    const cases: [string, boolean][] = [
      ['redis://cache.internal:6379', true],
      ['valkey://u:pw@10.0.0.5', true],
      ['redis://localhost:6379', false],
      ['rediss://cache.internal:6379', false],
    ];
    for (const [url, warns] of cases) {
      const messages: string[] = [];
      const store = new RedisLockStore({ url, logger: { warn: (m) => messages.push(m) } });
      expect([url, messages.some((m) => m.includes('rediss://'))]).toEqual([url, warns]);
      expect(messages.some((m) => m.includes('pw@'))).toBe(false);
      await store.close();
    }
  });

  test('requireTls throws for plaintext remote URLs', () => {
    expect(() => new RedisLockStore({ url: 'redis://cache.internal', requireTls: true })).toThrow(
      ScheduleConfigError,
    );
  });

  test('a supplied client bypasses the check and is not closed', async () => {
    const close = mock(() => {});
    const warn = mock(() => {});
    const store = new RedisLockStore({
      client: { close } as unknown as RedisClient,
      url: 'redis://cache.internal',
      requireTls: true,
      logger: { warn },
    });
    await store.close();
    expect(warn).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('RedisLockStore commands', () => {
  test('acquire sends SET NX PX under the prefix and maps the reply', async () => {
    const calls: [string, string[]][] = [];
    let reply: string | null = 'OK';
    const client = {
      send: async (cmd: string, args: string[]) => {
        calls.push([cmd, args]);
        return reply;
      },
    } as unknown as RedisClient;
    const store = new RedisLockStore({ client, prefix: 'p:' });
    expect(await store.acquire('job:123', 60_000)).toBe(true);
    reply = null;
    expect(await store.acquire('job:123', 60_000)).toBe(false);
    expect(calls[0]).toEqual(['SET', ['p:job:123', '1', 'NX', 'PX', '60000']]);
  });

  test('a client that never answers fails after commandTimeout', async () => {
    const never = { send: () => new Promise(() => {}) } as unknown as RedisClient;
    await expect(
      new RedisLockStore({ client: never, commandTimeout: 20 }).acquire('k', 1_000),
    ).rejects.toThrow('within 20ms');
  });

  test('invalid options and TTLs are refused', async () => {
    const client = { send: async () => 'OK' } as unknown as RedisClient;
    for (const commandTimeout of [0, 1.5, -1]) {
      expect(() => new RedisLockStore({ client, commandTimeout })).toThrow(ScheduleConfigError);
    }
    await expect(new RedisLockStore({ client }).acquire('k', 0)).rejects.toThrow(
      ScheduleConfigError,
    );
  });
});
