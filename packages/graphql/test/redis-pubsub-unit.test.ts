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
});
