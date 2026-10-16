import { describe, expect, test } from 'bun:test';
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
