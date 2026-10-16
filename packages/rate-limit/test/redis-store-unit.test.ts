import { describe, expect, test } from 'bun:test';
import { HttpConfigError, MemoryLogger } from '@hpmws/http';
import type { RedisClient } from 'bun';
import { RedisStore } from '../src/index.js';

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
