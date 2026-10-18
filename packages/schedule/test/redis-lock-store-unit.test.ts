import { describe, expect, mock, spyOn, test } from 'bun:test';
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

  test('without a logger, the warning waits for setLogger()', async () => {
    const messages: string[] = [];
    const store = new RedisLockStore({ url: 'redis://cache.internal:6379' });
    store.setLogger({ warn: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith('[knead:schedule] RedisLockStore connects to');
    store.setLogger({ warn: () => messages.push('again') });
    expect(messages).toHaveLength(1);
    await store.close();
  });

  test('without setLogger(), the warning goes to a ConsoleLogger at the first acquire()', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new RedisLockStore({ url: 'redis://cache.invalid:6379', commandTimeout: 50 });
      expect(warn).not.toHaveBeenCalled();
      await store.acquire('job:1', 1000).catch(() => {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toStartWith('[knead] [knead:schedule] ');
      await store.close();
    } finally {
      warn.mockRestore();
    }
  });

  test('an explicit logger option wins over setLogger()', async () => {
    const own: string[] = [];
    const app: string[] = [];
    const store = new RedisLockStore({
      url: 'redis://cache.internal:6379',
      logger: { warn: (m) => own.push(m) },
    });
    store.setLogger({ warn: (m) => app.push(m) });
    expect([own.length, app.length]).toEqual([1, 0]);
    await store.close();
  });

  test('requireTls throws for plaintext remote URLs', () => {
    expect(() => new RedisLockStore({ url: 'redis://cache.internal', requireTls: true })).toThrow(
      ScheduleConfigError,
    );
  });

  test('a supplied client bypasses the check and is not closed', async () => {
    const close = mock(() => {});
    const warn = mock(() => {});
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://cache.internal';
    try {
      const store = new RedisLockStore({
        client: { close } as unknown as RedisClient,
        requireTls: true,
        logger: { warn },
      });
      await store.close();
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
    expect(warn).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  test('REDIS_URL is checked when no client or url is given', () => {
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://cache.internal';
    try {
      expect(() => new RedisLockStore({ requireTls: true })).toThrow(ScheduleConfigError);
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});

describe('RedisLockStore commands', () => {
  test('acquire sends SET NX PX under the prefix and maps the reply', async () => {
    const calls: [string, string[]][] = [];
    let reply: string | null = 'OK';
    const client = {
      connected: true,
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

  test('commandTimeout defaults to 250 ms', async () => {
    const never = { connected: true, send: () => new Promise(() => {}) } as unknown as RedisClient;
    const started = performance.now();
    await expect(new RedisLockStore({ client: never }).acquire('k', 1_000)).rejects.toThrow(
      'within 250ms',
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
  });

  test('a client that never answers fails after commandTimeout', async () => {
    const never = { connected: true, send: () => new Promise(() => {}) } as unknown as RedisClient;
    await expect(
      new RedisLockStore({ client: never, commandTimeout: 20 }).acquire('k', 1_000),
    ).rejects.toThrow('within 20ms');
  });

  test('invalid options and TTLs are refused', async () => {
    const client = { connected: true, send: async () => 'OK' } as unknown as RedisClient;
    for (const commandTimeout of [0, 1.5, -1]) {
      expect(() => new RedisLockStore({ client, commandTimeout })).toThrow(ScheduleConfigError);
    }
    await expect(new RedisLockStore({ client }).acquire('k', 0)).rejects.toThrow(
      ScheduleConfigError,
    );
  });

  test('client and url together are refused', () => {
    const client = { send: async () => 'OK' } as unknown as RedisClient;
    expect(() => new RedisLockStore({ client, url: 'redis://localhost' })).toThrow(/client or url/);
  });

  test('a supplied client is not connected by the store', async () => {
    const sent: string[] = [];
    const connect = mock(() => Promise.resolve());
    const client = {
      connected: false,
      connect,
      send: async (cmd: string) => {
        sent.push(cmd);
        return 'OK';
      },
    } as unknown as RedisClient;
    const store = new RedisLockStore({ client, commandTimeout: 20 });
    expect(await store.acquire('k', 1_000)).toBe(true);
    expect(sent).toEqual(['SET']);
    expect(connect).not.toHaveBeenCalled();
  });

  test('its own client connects first, and fails within commandTimeout when unreachable', async () => {
    const store = new RedisLockStore({
      url: 'redis://127.0.0.1:1',
      commandTimeout: 50,
      logger: { warn: () => {} },
    });
    const started = performance.now();
    await expect(store.acquire('k', 1_000)).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
    await store.close();
  });
});
