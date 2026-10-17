import { describe, expect, setSystemTime, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { HttpConfigError, MemoryLogger } from '@knead-js/http';
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
    await until(() => fake.subscribed.includes('knead:gql:b'));
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
    await until(() => fake.subscribed.includes('knead:gql:a'));
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
      'subscribe knead:gql:t',
      'unsubscribe knead:gql:t',
      'subscribe knead:gql:t',
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
      ['redis://[::ffff:127.0.0.1]:6379', false],
      ['valkey://cache.internal:6379', true],
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

  test('publishTimeout: a client that never answers fails publishOrThrow, publish logs', async () => {
    const never = {
      publish: () => new Promise(() => {}),
      close: () => {},
    } as unknown as RedisClient;
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ client: never, logger, publishTimeout: 20 });
    await expect(pubsub.publishOrThrow('t', 1)).rejects.toThrow('within 20ms');
    await expect(pubsub.publish('t', 1)).resolves.toBeUndefined();
    expect(
      logger.entries.some((e) => e.level === 'error' && e.message.includes('within 20ms')),
    ).toBe(true);
    await pubsub.close();
    expect(() => new RedisPubSub({ client: never, publishTimeout: 0 })).toThrow(HttpConfigError);
  });

  test('warns once at construction without signingKey on a non-loopback server', async () => {
    const cases: [object, boolean][] = [
      [{ url: 'rediss://cache.internal' }, true],
      [{ url: 'rediss://cache.internal', signingKey: 'k'.repeat(32) }, false],
      [{ url: 'redis://127.0.0.1:6379' }, false],
      [{ url: 'redis+unix:///tmp/redis.sock' }, false],
      [{ client: loopback().client }, false],
    ];
    for (const [options, warns] of cases) {
      const logger = new MemoryLogger();
      const pubsub = new RedisPubSub({ logger, ...options });
      const warnings = logger.entries.filter((e) => e.message.includes('no signingKey'));
      expect([options, warnings.length]).toEqual([options, warns ? 1 : 0]);
      await pubsub.close();
    }
  });

  test('a throwing onError callback is logged and the other listeners still hear', async () => {
    const client = {
      duplicate: async () => Promise.reject(new Error('no connection')),
      close: () => {},
    } as unknown as RedisClient;
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ client, logger });
    const heard: string[] = [];
    pubsub.subscribe(
      't',
      () => {},
      () => {
        heard.push('first');
        throw new Error('callback bug');
      },
    );
    pubsub.subscribe(
      't',
      () => {},
      (error) => heard.push(`second: ${error.message}`),
    );
    await until(() => heard.length === 2);
    expect(heard).toEqual(['first', 'second: no connection']);
    await until(() => logger.entries.some((e) => e.message.includes('onError callback')));
    await until(() => pubsub.pendingOperations === 0);
    await pubsub.close();
  });

  test('a failing queued operation never stalls the topic queue', async () => {
    let subscribes = 0;
    const subscriber = {
      subscribe: async () => {
        subscribes++;
        if (subscribes === 1) throw new Error('first subscribe fails');
        return 1;
      },
      unsubscribe: async () => {},
      close: () => {},
      connected: false,
    };
    const client = { duplicate: async () => subscriber, close: () => {} } as unknown as RedisClient;
    let calls = 0;
    // A logger that throws once makes the subscribe op itself reject.
    const logger = new MemoryLogger();
    const original = logger.error.bind(logger);
    logger.error = (message: string, ...meta: unknown[]) => {
      if (calls++ === 0) throw new Error('logger down');
      original(message, ...meta);
    };
    const pubsub = new RedisPubSub({ client, logger });
    pubsub.subscribe('t', () => {});
    await until(() => pubsub.pendingOperations === 0);
    pubsub.subscribe('t', () => {});
    await until(() => subscribes === 2);
    await until(() => pubsub.pendingOperations === 0);
    await pubsub.close();
  });

  test('a received payload is deep-frozen before listeners see it', async () => {
    const fake = loopback();
    const pubsub = new RedisPubSub({ client: fake.client, logger: new MemoryLogger() });
    const seen: { a: { b: number } }[] = [];
    pubsub.subscribe('t', (payload) => seen.push(payload as { a: { b: number } }));
    pubsub.subscribe('t', (payload) => seen.push(payload as { a: { b: number } }));
    await until(() => fake.subscribed() === 1);
    fake.inject('knead:gql:t', JSON.stringify({ a: { b: 1 } }));
    expect(seen).toHaveLength(2);
    expect(Object.isFrozen(seen[0]!.a)).toBe(true);
    expect(seen[0]).toBe(seen[1]!);
    await pubsub.close();
  });

  test('requireTls: a plaintext remote URL throws at construction', () => {
    expect(() => new RedisPubSub({ url: 'redis://cache.internal', requireTls: true })).toThrow(
      HttpConfigError,
    );
    expect(() => new RedisPubSub({ url: 'valkey://10.0.0.5', requireTls: true })).toThrow(
      HttpConfigError,
    );
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
    fake.inject('knead:gql:t', JSON.stringify({ n: 2 }));
    fake.inject('knead:gql:t', `${'0'.repeat(64)}.${Date.now()}.${JSON.stringify({ n: 3 })}`);
    const other = new RedisPubSub({ client: fake.client, signingKey: 'x'.repeat(32), logger });
    await other.publish('t', { n: 4 });
    expect(received).toEqual([{ n: 1 }]);
    // Drops are reported at most once per 10s, with a count.
    const drops = logger.entries.filter(
      (e) => e.level === 'warn' && e.message.includes('signature'),
    );
    expect(drops.length).toBe(1);
    for (const p of [sender, receiver, other]) await p.close();
  });

  test('signingKey rotation: sign with the first key, accept any', async () => {
    const fake = loopback();
    const oldKey = 'o'.repeat(32);
    const newKey = 'n'.repeat(32);
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({ client: fake.client, signingKey: [newKey, oldKey], logger });
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    await new RedisPubSub({ client: fake.client, signingKey: oldKey }).publish('t', 1);
    await new RedisPubSub({ client: fake.client, signingKey: [newKey, oldKey] }).publish('t', 2);
    await new RedisPubSub({ client: fake.client, signingKey: 'z'.repeat(32) }).publish('t', 3);
    expect(received).toEqual([1, 2]);
    // The rotated publisher signs with the first key only: an old-key-only receiver rejects it.
    const oldOnly = new RedisPubSub({ client: fake.client, signingKey: oldKey, logger });
    const seen: unknown[] = [];
    oldOnly.subscribe('u', (payload) => seen.push(payload));
    await until(() => fake.subscribed() === 2);
    await new RedisPubSub({ client: fake.client, signingKey: [newKey, oldKey] }).publish('u', 4);
    expect(seen).toEqual([]);
    await receiver.close();
    await oldOnly.close();
  });

  test('Uint8Array keys are copied at construction', async () => {
    const fake = loopback();
    const key = new Uint8Array(32).fill(7);
    const receiver = new RedisPubSub({
      client: fake.client,
      signingKey: key,
      logger: new MemoryLogger(),
    });
    const sender = new RedisPubSub({ client: fake.client, signingKey: Uint8Array.from(key) });
    key.fill(0); // the caller reuses its buffer
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    await sender.publish('t', 1);
    expect(received).toEqual([1]);
    await receiver.close();
  });

  test('key and maxSignatureAge validation', () => {
    const client = loopback().client;
    for (const signingKey of ['short', [], ['k'.repeat(32), 'short'], new Uint8Array(31)]) {
      expect(() => new RedisPubSub({ client, signingKey })).toThrow(HttpConfigError);
    }
    for (const maxSignatureAge of [0, -1, 1.5, 600_001]) {
      expect(() => new RedisPubSub({ client, maxSignatureAge })).toThrow(HttpConfigError);
    }
    expect(() => new RedisPubSub({ client, maxSignatureAge: 600_000 })).not.toThrow();
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
    fake.inject('knead:gql:b', captured);
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
        .update(`knead:gql:t\0${ts}\0${json}`)
        .digest('hex');
      return `${mac}.${ts}.${json}`;
    };
    fake.inject('knead:gql:t', signed(Date.now(), { fresh: true }));
    fake.inject('knead:gql:t', signed(Date.now() - 6000, { stale: true }));
    fake.inject('knead:gql:t', signed(Date.now() + 61_000, { future: true }));
    expect(received).toEqual([{ fresh: true }]);
    expect(logger.entries.filter((e) => e.message.includes('signature')).length).toBe(1);
    await receiver.close();
  });

  test('a flood of forged messages logs one report per 10s, with a count', async () => {
    const fake = loopback();
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({ client: fake.client, signingKey: 'k'.repeat(32), logger });
    receiver.subscribe('t', () => {});
    await until(() => fake.subscribed() === 1);
    try {
      for (let i = 0; i < 1000; i++) fake.inject('knead:gql:t', `${'0'.repeat(64)}.1.{}`);
      expect(logger.entries.length).toBe(1);
      expect(logger.entries[0]!.message).toContain('dropped 1 message(s)');
      setSystemTime(new Date(Date.now() + 11_000));
      fake.inject('knead:gql:t', 'forged');
      expect(logger.entries.length).toBe(2);
      expect(logger.entries[1]!.message).toContain('dropped 1000 message(s)');
    } finally {
      setSystemTime();
      await receiver.close();
    }
  });

  test('messages over maxMessageBytes are dropped before any HMAC or JSON work', async () => {
    const fake = loopback();
    const logger = new MemoryLogger();
    const receiver = new RedisPubSub({
      client: fake.client,
      signingKey: 'k'.repeat(32),
      logger,
      maxMessageBytes: 1024,
    });
    const received: unknown[] = [];
    receiver.subscribe('t', (payload) => received.push(payload));
    await until(() => fake.subscribed() === 1);
    const huge = `${'0'.repeat(64)}.${Date.now()}.${JSON.stringify('x'.repeat(10 * 1024 * 1024))}`;
    const started = performance.now();
    fake.inject('knead:gql:t', huge);
    expect(performance.now() - started).toBeLessThan(20);
    expect(logger.entries[0]!.message).toContain('larger than 1024 bytes');
    const sender = new RedisPubSub({
      client: fake.client,
      signingKey: 'k'.repeat(32),
      maxMessageBytes: 1024,
    });
    await expect(sender.publishOrThrow('t', 'x'.repeat(2000))).rejects.toThrow('maxMessageBytes');
    await sender.publish('t', 'small');
    expect(received).toEqual(['small']);
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

  describe('encryptionKey', () => {
    const key = 'e'.repeat(32);
    /** A publisher that captures what it would send. */
    const capture = () => {
      const sent: string[] = [];
      const client = {
        publish: async (_channel: string, message: string) => {
          sent.push(message);
          return 1;
        },
        close: () => {},
      } as unknown as RedisClient;
      return { client, sent };
    };
    const receiver = async (fake: ReturnType<typeof loopback>, options: object, topic = 't') => {
      const logger = new MemoryLogger();
      const pubsub = new RedisPubSub({ client: fake.client, logger, ...options });
      const received: unknown[] = [];
      pubsub.subscribe(topic, (payload) => received.push(payload));
      await until(() => fake.subscribed() >= 1);
      return { pubsub, received, logger };
    };

    test('round trip: the payload never crosses Redis in clear text', async () => {
      const spy = capture();
      await new RedisPubSub({ client: spy.client, encryptionKey: key }).publish('t', {
        secret: 'x',
      });
      expect(spy.sent[0]).toStartWith('e2.');
      expect(spy.sent[0]).not.toContain('secret');
      const fake = loopback();
      const r = await receiver(fake, { encryptionKey: key });
      fake.inject('knead:gql:t', spy.sent[0]!);
      expect(r.received).toEqual([{ secret: 'x' }]);
      // Every message gets a fresh IV.
      await new RedisPubSub({ client: spy.client, encryptionKey: key }).publish('t', {
        secret: 'x',
      });
      expect(spy.sent[1]).not.toBe(spy.sent[0]);
      await r.pubsub.close();
    });

    test('tampered, wrong-key and unencrypted messages are dropped and logged', async () => {
      const spy = capture();
      await new RedisPubSub({ client: spy.client, encryptionKey: key }).publish('t', 1);
      await new RedisPubSub({ client: spy.client, encryptionKey: 'w'.repeat(32) }).publish('t', 2);
      const fake = loopback();
      const r = await receiver(fake, { encryptionKey: key });
      const good = spy.sent[0]!;
      const flipped = `${good.slice(0, -2)}${good.at(-2) === 'A' ? 'B' : 'A'}${good.at(-1)}`;
      fake.inject('knead:gql:t', flipped);
      fake.inject('knead:gql:t', spy.sent[1]!);
      fake.inject('knead:gql:t', JSON.stringify(3));
      expect(r.received).toEqual([]);
      expect(r.logger.entries.some((e) => e.message.includes('failed to decrypt'))).toBe(true);
      await r.pubsub.close();
    });

    test('rotation: encrypt with the first key, decrypt with any', async () => {
      const spy = capture();
      await new RedisPubSub({ client: spy.client, encryptionKey: 'o'.repeat(32) }).publish('t', 1);
      await new RedisPubSub({ client: spy.client, encryptionKey: [key, 'o'.repeat(32)] }).publish(
        't',
        2,
      );
      const fake = loopback();
      const r = await receiver(fake, { encryptionKey: [key, 'o'.repeat(32)] });
      for (const message of spy.sent) fake.inject('knead:gql:t', message);
      expect(r.received).toEqual([1, 2]);
      const onlyOld = await receiver(loopback(), { encryptionKey: 'o'.repeat(32) });
      expect(onlyOld.received).toEqual([]);
      await r.pubsub.close();
      await onlyOld.pubsub.close();
    });

    test('a message replayed on another topic fails (the channel is the AAD)', async () => {
      const spy = capture();
      await new RedisPubSub({ client: spy.client, encryptionKey: key }).publish('a', 1);
      const fake = loopback();
      const r = await receiver(fake, { encryptionKey: key }, 'b');
      fake.inject('knead:gql:b', spy.sent[0]!);
      expect(r.received).toEqual([]);
      expect(r.logger.entries.some((e) => e.message.includes('failed to decrypt'))).toBe(true);
      await r.pubsub.close();
    });

    test('combined with signingKey: encrypted, then the envelope signed', async () => {
      const fake = loopback();
      const options = { encryptionKey: key, signingKey: 's'.repeat(32) };
      const r = await receiver(fake, options);
      await new RedisPubSub({ client: fake.client, ...options }).publish('t', { n: 1 });
      expect(r.received).toEqual([{ n: 1 }]);
      await r.pubsub.close();
    });

    test('without signingKey, encrypted messages still go stale and their timestamp is authenticated', async () => {
      const spy = capture();
      await new RedisPubSub({ client: spy.client, encryptionKey: key }).publish('t', 1);
      const captured = spy.sent[0]!;
      const fake = loopback();
      const r = await receiver(fake, { encryptionKey: key, maxSignatureAge: 5000 });
      // Re-dating the envelope breaks the AAD.
      const [, ts, ...rest] = captured.split('.');
      fake.inject('knead:gql:t', ['e2', String(Number(ts) + 1), ...rest].join('.'));
      expect(r.received).toEqual([]);
      // Replaying it after maxSignatureAge is refused.
      setSystemTime(new Date(Date.now() + 6000));
      try {
        fake.inject('knead:gql:t', captured);
        expect(r.received).toEqual([]);
      } finally {
        setSystemTime();
      }
      // Fresh, it is delivered.
      fake.inject('knead:gql:t', captured);
      expect(r.received).toEqual([1]);
      await r.pubsub.close();
    });

    test('keys shorter than 32 bytes are rejected', () => {
      expect(() => new RedisPubSub({ client: loopback().client, encryptionKey: 'short' })).toThrow(
        HttpConfigError,
      );
    });
  });
});

describe('RedisPubSub connection loss', () => {
  function watchedClient() {
    const subscribers: {
      onclose: ((error: Error) => void) | null;
      onconnect: (() => void) | null;
      closed: boolean;
    }[] = [];
    const client = {
      duplicate: async () => {
        const subscriber = {
          onclose: null as ((error: Error) => void) | null,
          onconnect: null as (() => void) | null,
          connected: true,
          closed: false,
          subscribe: async () => 1,
          unsubscribe: async () => {},
          close() {
            subscriber.closed = true;
          },
        };
        subscribers.push(subscriber);
        return subscriber;
      },
      publish: async () => 1,
      close: () => {},
    };
    return { client: client as unknown as RedisClient, subscribers };
  }

  for (const event of ['onclose', 'onconnect'] as const) {
    test(`a subscriber ${event} after SUBSCRIBE ends every subscription; the next subscribe reconnects`, async () => {
      const fake = watchedClient();
      const logger = new MemoryLogger();
      const pubsub = new RedisPubSub({ client: fake.client, logger });
      const errors: string[] = [];
      pubsub.subscribe(
        'a',
        () => {},
        () => errors.push('a1'),
      );
      pubsub.subscribe(
        'a',
        () => {},
        () => errors.push('a2'),
      );
      pubsub.subscribe(
        'b',
        () => {},
        () => errors.push('b'),
      );
      await until(() => pubsub.pendingOperations === 0);
      const first = fake.subscribers[0]!;
      expect(first.onclose).toBeFunction();
      if (event === 'onclose') first.onclose!(new Error('Connection closed'));
      else first.onconnect!();
      expect(errors.sort()).toEqual(['a1', 'a2', 'b']);
      expect(first.closed).toBe(true);
      expect(logger.entries.some((e) => e.message.includes('lost its subscriber'))).toBe(true);
      pubsub.subscribe('a', () => {});
      await until(() => fake.subscribers.length === 2);
      await pubsub.close();
    });
  }

  test('close() does not report its own subscriber close as a loss', async () => {
    const fake = watchedClient();
    const pubsub = new RedisPubSub({ client: fake.client, logger: new MemoryLogger() });
    const errors: Error[] = [];
    pubsub.subscribe(
      'a',
      () => {},
      (error) => errors.push(error),
    );
    await until(() => pubsub.pendingOperations === 0);
    const first = fake.subscribers[0]!;
    await pubsub.close();
    first.onclose?.(new Error('Connection closed'));
    expect(errors).toEqual([]);
  });
});
