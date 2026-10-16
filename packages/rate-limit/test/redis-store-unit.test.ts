import { describe, expect, test } from 'bun:test';
import { HttpConfigError, MemoryLogger } from '@knead/http';
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

  test('a hashSecret shorter than 32 bytes is rejected', () => {
    expect(() => new RedisStore({ client: {} as RedisClient, hashSecret: 'short' })).toThrow(
      RangeError,
    );
  });
});
