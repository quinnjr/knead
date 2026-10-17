import { describe, expect, spyOn, test } from 'bun:test';
import { HttpConfigError, MemoryLogger } from '@knead-js/http';
import type { RedisClient } from 'bun';
import { hashKey, RedisStore } from '../src/index.js';
import { resetUnkeyedHashWarning } from '../src/redis-store.js';

describe('RedisStore plaintext guardrails', () => {
  test('warns at construction about plaintext redis:// to a non-loopback host', async () => {
    const cases: [string, boolean][] = [
      ['redis://cache.internal:6379', true],
      ['valkey://u:pw@10.0.0.5', true],
      ['redis://localhost:6379', false],
      ['redis://[::ffff:127.0.0.1]:6379', false],
      ['rediss://cache.internal:6379', false],
    ];
    for (const [url, warns] of cases) {
      const logger = new MemoryLogger();
      const store = new RedisStore({ url, logger });
      const warned = logger.entries.some(
        (e) => e.level === 'warn' && e.message.includes('rediss://'),
      );
      expect([url, warned]).toEqual([url, warns]);
      expect(logger.entries.some((e) => e.message.includes('pw@'))).toBe(false);
      await store.close();
    }
  });

  test('requireTls throws for plaintext remote URLs', () => {
    expect(() => new RedisStore({ url: 'redis://cache.internal', requireTls: true })).toThrow(
      HttpConfigError,
    );
  });

  test('a supplied client bypasses the check', () => {
    const logger = new MemoryLogger();
    new RedisStore({
      client: {} as RedisClient,
      url: 'redis://cache.internal',
      logger,
      requireTls: true,
    });
    expect(logger.entries).toEqual([]);
  });
});

describe('RedisStore commandTimeout', () => {
  const never = { send: () => new Promise(() => {}) } as unknown as RedisClient;
  const rule = { limit: 1, windowMs: 1000, algorithm: 'sliding-window' as const };

  test('a client that never answers fails after commandTimeout (default 250 ms)', async () => {
    const started = performance.now();
    await expect(new RedisStore({ client: never }).consume('k', rule)).rejects.toThrow(
      'did not answer within 250ms',
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
    await expect(
      new RedisStore({ client: never, commandTimeout: 20 }).consume('k', rule),
    ).rejects.toThrow('within 20ms');
  });

  test('invalid commandTimeout values are rejected', () => {
    for (const commandTimeout of [0, -1, 1.5]) {
      expect(() => new RedisStore({ client: never, commandTimeout })).toThrow(RangeError);
    }
  });
});

describe('keyed hashes', () => {
  const rule = { limit: 5, windowMs: 60_000, algorithm: 'token-bucket' as const };
  const recording = () => {
    const keys: string[] = [];
    const client = {
      send: async (_command: string, args: string[]) => {
        keys.push(args[2]!);
        return [1, 4, Date.now()];
      },
    } as unknown as RedisClient;
    return { client, keys };
  };

  test('hashKey is HMAC-SHA256 under a secret, plain SHA-256 without', () => {
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const secret = 's'.repeat(32);
    expect(hashKey('global|1.2.3.4', secret)).toBe(
      createHmac('sha256', secret).update('global|1.2.3.4').digest('hex').slice(0, 32),
    );
    expect(hashKey('global|1.2.3.4', secret)).not.toBe(hashKey('global|1.2.3.4'));
  });

  test('RedisStore with hashSecret stores HMAC keys and does not warn', async () => {
    resetUnkeyedHashWarning();
    const logger = new MemoryLogger();
    const secret = new Uint8Array(32).fill(9);
    const { client, keys } = recording();
    const store = new RedisStore({ client, hashSecret: secret, logger });
    secret.fill(0); // copied at construction
    await store.consume('global|203.0.113.9', rule);
    expect(keys[0]).toBe(
      `knead:rl:${hashKey('global|203.0.113.9', new Uint8Array(32).fill(9))}:60000`,
    );
    expect(logger.entries).toEqual([]);
  });

  test('without hashSecret: unkeyed SHA-256 and a one-time warning', async () => {
    resetUnkeyedHashWarning();
    const first = new MemoryLogger();
    const second = new MemoryLogger();
    const { client, keys } = recording();
    await new RedisStore({ client, logger: first }).consume('global|203.0.113.9', rule);
    new RedisStore({ client, logger: second });
    expect(keys[0]).toBe(`knead:rl:${hashKey('global|203.0.113.9')}:60000`);
    expect(first.entries.filter((e) => e.message.includes('no hashSecret'))).toHaveLength(1);
    expect(second.entries).toEqual([]);
    resetUnkeyedHashWarning();
    const raw = new MemoryLogger();
    new RedisStore({ client, logger: raw, hashKeys: false });
    expect(raw.entries).toEqual([]);
  });

  // Pinned with the node:crypto createHmac implementation: existing Redis keys must not change.
  test('hashKey output is stable', () => {
    expect(hashKey('global|203.0.113.9', 's'.repeat(32))).toBe('5c3f41ca62a9f2ca3fd81f2dad635553');
    expect(hashKey('guard:GET /x|2001:db8::/64', new Uint8Array(32).fill(9))).toBe(
      '11dacf063780084dad93167aea8e9ff9',
    );
    expect(hashKey('\u00e9\u{1F600}|k', 'p\u00e4ss-'.repeat(8))).toBe(
      '89027d271ebb39985b25af90f2f5eabe',
    );
  });

  test('a hashSecret shorter than 32 bytes is rejected', () => {
    expect(() => new RedisStore({ client: {} as RedisClient, hashSecret: 'short' })).toThrow(
      RangeError,
    );
  });
});

describe('RedisStore owned client', () => {
  test('an unreachable server fails within commandTimeout instead of queueing', async () => {
    const store = new RedisStore({
      url: 'redis://127.0.0.1:1',
      commandTimeout: 50,
      logger: new MemoryLogger(),
      hashKeys: false,
    });
    const started = performance.now();
    await expect(
      store.consume('k', { limit: 1, windowMs: 1000, algorithm: 'sliding-window' }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
    await store.close();
  });
});

describe('RedisStore logger', () => {
  const client = { send: async () => [1, 1, Date.now() + 1000] } as unknown as RedisClient;
  const rule = { limit: 1, windowMs: 1000, algorithm: 'sliding-window' as const };

  test('without a logger option, construction warnings wait for setLogger()', () => {
    resetUnkeyedHashWarning();
    const store = new RedisStore({ client });
    const app = new MemoryLogger();
    store.setLogger(app);
    expect(app.entries.filter((e) => e.message.includes('no hashSecret'))).toHaveLength(1);
    // Delivered once.
    const again = new MemoryLogger();
    store.setLogger(again);
    expect(again.entries).toEqual([]);
  });

  test('without setLogger(), they go to a ConsoleLogger at the first consume()', async () => {
    resetUnkeyedHashWarning();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new RedisStore({ client });
      expect(warn).not.toHaveBeenCalled();
      await store.consume('k', rule);
      await store.consume('k', rule);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('[knead:rate-limit]');
    } finally {
      warn.mockRestore();
    }
  });

  test('an explicit logger option wins over setLogger()', () => {
    resetUnkeyedHashWarning();
    const own = new MemoryLogger();
    const store = new RedisStore({ client, logger: own });
    expect(own.entries).toHaveLength(1);
    const app = new MemoryLogger();
    store.setLogger(app);
    expect(app.entries).toEqual([]);
  });
});

describe('RedisStore NOSCRIPT fallback', () => {
  const rule = { limit: 1, windowMs: 1000, algorithm: 'sliding-window' as const };

  test('falls back to EVAL when the script is not loaded', async () => {
    const sent: string[] = [];
    const client = {
      connected: true,
      send: async (command: string) => {
        sent.push(command);
        if (command === 'EVALSHA') throw new Error('NOSCRIPT No matching script');
        return [1, 0, Date.now()];
      },
    } as unknown as RedisClient;
    const result = await new RedisStore({ client, hashSecret: 'x'.repeat(32) }).consume('k', rule);
    expect(result.allowed).toBe(true);
    expect(sent).toEqual(['EVALSHA', 'EVAL']);
  });

  test('never sends the EVAL once commandTimeout has passed', async () => {
    const sent: string[] = [];
    const client = {
      connected: true,
      send: async (command: string) => {
        sent.push(command);
        if (command === 'EVALSHA') {
          await Bun.sleep(60);
          throw new Error('NOSCRIPT No matching script');
        }
        return [1, 0, Date.now()];
      },
    } as unknown as RedisClient;
    const store = new RedisStore({ client, commandTimeout: 20, hashSecret: 'x'.repeat(32) });
    await expect(store.consume('k', rule)).rejects.toThrow('within 20ms');
    await Bun.sleep(80);
    expect(sent).toEqual(['EVALSHA']);
  });
});
