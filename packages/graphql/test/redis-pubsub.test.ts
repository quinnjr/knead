import { afterAll, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
import { RedisClient } from 'bun';
import {
  Mutation,
  PUBSUB,
  Query,
  RedisPubSub,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { startGraphQL, until } from './helpers.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('RedisPubSub', () => {
  const prefix = `hpmws:test:${crypto.randomUUID()}:`;
  const admin = url ? new RedisClient(url) : undefined;
  afterAll(() => admin?.close());

  const channelSubscribers = async (channel: string) => {
    const reply = (await admin!.send('PUBSUB', ['NUMSUB', prefix + channel])) as [string, number];
    return Number(reply[1]);
  };

  test('delivers JSON payloads to local subscribers and unsubscribes from Redis', async () => {
    const pubsub = new RedisPubSub({ url, prefix });
    const received: unknown[] = [];
    const off = pubsub.subscribe('t', (p) => received.push(p));
    await until(async () => (await channelSubscribers('t')) === 1);
    await pubsub.publish('t', { n: 1 });
    await until(() => received.length === 1);
    expect(received).toEqual([{ n: 1 }]);
    off();
    await until(async () => (await channelSubscribers('t')) === 0);
    await pubsub.close();
  });

  test('a subscription on one app instance receives events published by another', async () => {
    @Resolver()
    class R {
      readonly #pubsub = inject(PUBSUB);
      @Query(() => Boolean) ok() {
        return true;
      }
      @Mutation(() => Boolean, { args: { text: String } })
      say(ctx: ResolverCtx<{ text: string }>) {
        void this.#pubsub.publish('said', ctx.args.text);
        return true;
      }
      @Subscription(() => String, { topic: 'said' })
      said() {}
    }
    @Module({ providers: [R] })
    class M {}
    const a = await startGraphQL([M], { pubsub: new RedisPubSub({ url, prefix }) });
    const b = await startGraphQL([M], { pubsub: new RedisPubSub({ url, prefix }) });
    try {
      const sub = await a.app.graphqlSubscribe<{ said: string }>('subscription { said }');
      await until(async () => (await channelSubscribers('said')) === 1);
      await b.app.graphql('mutation { say(text: "across") }');
      expect((await sub.next()).value).toEqual({ data: { said: 'across' } });
      await sub.close();
    } finally {
      await a.mod.close();
      await b.mod.close();
    }
  });
});
