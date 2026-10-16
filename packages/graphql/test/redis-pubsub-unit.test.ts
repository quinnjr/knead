import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MemoryLogger } from '@hpmws/http';
import type { RedisClient } from 'bun';
import { RedisPubSub } from '../src/index.js';
import { until } from './helpers.js';

function fakeClient(failures: number) {
  let duplicates = 0;
  const subscribed: string[] = [];
  const subscriber = {
    subscribe: async (channel: string) => {
      subscribed.push(channel);
      return 1;
    },
    unsubscribe: async () => {},
    close: () => {},
  };
  const client = {
    duplicate: async () => {
      duplicates++;
      if (duplicates <= failures) throw new Error('connection refused');
      return subscriber;
    },
    publish: async () => 1,
    close: () => {},
  };
  return { client: client as unknown as RedisClient, subscribed, duplicates: () => duplicates };
}

describe('RedisPubSub failure handling', () => {
  test('a failed subscriber connection is logged, surfaced to the subscriber and retried', async () => {
    const fake = fakeClient(1);
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ client: fake.client, logger });
    const errors: Error[] = [];
    pubsub.subscribe(
      'a',
      () => {},
      (error) => errors.push(error),
    );
    await until(() => errors.length === 1);
    expect(logger.entries.some((e) => e.level === 'error' && e.message.includes('a'))).toBe(true);
    pubsub.subscribe('b', () => {});
    await until(() => fake.subscribed.includes('hpmws:gql:b'));
    expect(fake.duplicates()).toBe(2);
    await pubsub.close();
  });

  test('a topic whose Redis subscription failed is retried by the next subscriber', async () => {
    const fake = fakeClient(1);
    const pubsub = new RedisPubSub({ client: fake.client, logger: new MemoryLogger() });
    const errors: Error[] = [];
    pubsub.subscribe(
      'a',
      () => {},
      (error) => errors.push(error),
    );
    await until(() => errors.length === 1);
    pubsub.subscribe('a', () => {});
    await until(() => fake.subscribed.includes('hpmws:gql:a'));
    await pubsub.close();
  });

  test('unsubscribing while SUBSCRIBE is in flight waits for it, so Redis never holds two', async () => {
    // Mimics Bun's RedisClient: UNSUBSCRIBE outside subscriber mode throws, and each SUBSCRIBE
    // call registers another message handler for the channel.
    const ops: string[] = [];
    const handlers = new Map<string, ((message: string) => void)[]>();
    let release: (() => void) | undefined;
    const subscriber = {
      subscribe: async (channel: string, handler: (message: string) => void) => {
        ops.push(`subscribe ${channel}`);
        if (!release) await new Promise<void>((resolve) => (release = resolve));
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return 1;
      },
      unsubscribe: async (channel: string) => {
        if (!handlers.has(channel)) throw new Error('not in subscriber mode');
        ops.push(`unsubscribe ${channel}`);
        handlers.delete(channel);
      },
      close: () => {},
    };
    const client = {
      duplicate: async () => subscriber,
      publish: async (channel: string, message: string) => {
        for (const handler of handlers.get(channel) ?? []) handler(message);
        return 1;
      },
      close: () => {},
    } as unknown as RedisClient;
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ client, logger });
    const off = pubsub.subscribe('t', () => {});
    await until(() => ops.length === 1);
    off();
    const received: unknown[] = [];
    pubsub.subscribe('t', (payload) => received.push(payload));
    release?.();
    await until(() => ops.length === 3);
    expect(ops).toEqual([
      'subscribe hpmws:gql:t',
      'unsubscribe hpmws:gql:t',
      'subscribe hpmws:gql:t',
    ]);
    await pubsub.publish('t', { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
    expect(logger.entries.filter((e) => e.level !== 'info')).toEqual([]);
    await pubsub.close();
  });
});

/** A fake Redis whose PUBLISH reaches every SUBSCRIBE of the channel (shared between clients). */
function loopback(options: { publishFails?: boolean } = {}) {
  const handlers = new Map<string, ((message: string) => void)[]>();
  const subscriber = {
    subscribe: async (channel: string, handler: (message: string) => void) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return 1;
    },
    unsubscribe: async () => {},
    close: () => {},
    connected: false,
  };
  const client = {
    duplicate: async () => subscriber,
    publish: async (channel: string, message: string) => {
      if (options.publishFails) throw new Error('connection to redis://user:secret@db lost');
      for (const handler of handlers.get(channel) ?? []) handler(message);
      return 1;
    },
    close: () => {},
  } as unknown as RedisClient;
  const inject = (channel: string, message: string) => {
    for (const handler of handlers.get(channel) ?? []) handler(message);
  };
  return { client, inject, subscribed: () => handlers.size };
}

describe('RedisPubSub hardening', () => {
  test('publish never rejects: the failure is logged; publishOrThrow rejects', async () => {
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ client: loopback({ publishFails: true }).client, logger });
    await expect(pubsub.publish('t', 1)).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === 'error' && e.message.includes('t'))).toBe(true);
    await expect(pubsub.publishOrThrow('t', 1)).rejects.toThrow('connection');
    await pubsub.close();
  });

  test('warns at construction about plain redis:// to a non-loopback host', async () => {
    const cases: [string, boolean][] = [
      ['redis://cache.internal:6379', true],
      ['redis://user:pw@10.0.0.5:6379/0', true],
      ['redis://localhost:6379', false],
      ['redis://127.0.0.1:6379', false],
      ['redis://[::1]:6379', false],
      ['rediss://cache.internal:6379', false],
    ];
    for (const [url, warns] of cases) {
      const logger = new MemoryLogger();
      const pubsub = new RedisPubSub({ url, logger });
      const warned = logger.entries.some(
        (e) => e.level === 'warn' && e.message.includes('rediss://'),
      );
      expect([url, warned]).toEqual([url, warns]);
      expect(logger.entries.some((e) => e.message.includes('pw@'))).toBe(false);
      await pubsub.close();
    }
  });

  test('signingKey: signed messages are delivered; unsigned and forged ones are dropped', async () => {
    const fake = loopback();
    const signingKey = 'k'.repeat(32);
    const logger = new MemoryLogger();
    const sender = new RedisPubSub({ client: fake.client, signingKey, logger });
    const receiver = new RedisPubSub({ client: fake.client, signingKey, logger });
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    await sender.publish('t', { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
    fake.inject('hpmws:gql:t', JSON.stringify({ n: 2 }));
    fake.inject('hpmws:gql:t', `${'0'.repeat(64)}.${Date.now()}.${JSON.stringify({ n: 3 })}`);
    const other = new RedisPubSub({ client: fake.client, signingKey: 'x'.repeat(32), logger });
    await other.publish('t', { n: 4 });
    expect(received).toEqual([{ n: 1 }]);
    const drops = logger.entries.filter(
      (e) => e.level === 'warn' && e.message.includes('signature'),
    );
    expect(drops.length).toBe(3);
    for (const p of [sender, receiver, other]) await p.close();
  });

  test('the signature covers the topic', async () => {
    const fake = loopback();
    const signingKey = 'k'.repeat(32);
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({ client: fake.client, signingKey, logger });
    const received: unknown[] = [];
    receiver.subscribe('b', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    // Capture a message signed for topic "a" and replay it on "b".
    let captured = '';
    const spy = {
      publish: async (_channel: string, message: string) => {
        captured = message;
        return 1;
      },
      close: () => {},
    } as unknown as RedisClient;
    await new RedisPubSub({ client: spy, signingKey }).publish('a', { n: 1 });
    fake.inject('hpmws:gql:b', captured);
    expect(received).toEqual([]);
    await receiver.close();
  });

  test('a message replayed under another prefix is dropped (the MAC covers the prefix)', async () => {
    const fake = loopback();
    const signingKey = 'k'.repeat(32);
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({ client: fake.client, signingKey, logger, prefix: 'app-b:' });
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    let captured = '';
    const spy = {
      publish: async (_channel: string, message: string) => {
        captured = message;
        return 1;
      },
      close: () => {},
    } as unknown as RedisClient;
    await new RedisPubSub({ client: spy, signingKey, prefix: 'app-a:' }).publish('t', { n: 1 });
    fake.inject('app-b:t', captured);
    expect(received).toEqual([]);
    await receiver.close();
  });

  test('stale or future-dated messages are dropped; maxSignatureAge is configurable', async () => {
    const fake = loopback();
    const signingKey = 'k'.repeat(32);
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({
      client: fake.client,
      signingKey,
      logger,
      maxSignatureAge: 5000,
    });
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    const signed = (ts: number, payload: unknown) => {
      const json = JSON.stringify(payload);
      const mac = createHmac('sha256', signingKey)
        .update(`hpmws:gql:t\0${ts}\0${json}`)
        .digest('hex');
      return `${mac}.${ts}.${json}`;
    };
    fake.inject('hpmws:gql:t', signed(Date.now(), { fresh: true }));
    fake.inject('hpmws:gql:t', signed(Date.now() - 6000, { stale: true }));
    fake.inject('hpmws:gql:t', signed(Date.now() + 61_000, { future: true }));
    expect(received).toEqual([{ fresh: true }]);
    expect(logger.entries.filter((e) => e.message.includes('signature')).length).toBe(2);
    await receiver.close();
  });

  test('maxSignatureAge must be a positive integer', () => {
    expect(
      () =>
        new RedisPubSub({
          client: loopback().client,
          signingKey: 'k'.repeat(32),
          maxSignatureAge: 0,
        }),
    ).toThrow('maxSignatureAge');
  });

  test('a signingKey shorter than 32 bytes is a configuration error', () => {
    expect(() => new RedisPubSub({ client: loopback().client, signingKey: 'short' })).toThrow(
      '32 bytes',
    );
  });
});
