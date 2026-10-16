import { afterAll, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
import { MemoryLogger } from '@hpmws/http';
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

  test('a topic unsubscribed while SUBSCRIBE is in flight delivers each event once', async () => {
    const logger = new MemoryLogger();
    const pubsub = new RedisPubSub({ url, prefix, logger });
    pubsub.subscribe('race', () => {})(); // unsubscribe before Redis confirmed the SUBSCRIBE
    const received: unknown[] = [];
    const off = pubsub.subscribe('race', (p) => received.push(p));
    await until(async () => (await channelSubscribers('race')) === 1);
    await pubsub.publish('race', { n: 1 });
    await until(() => received.length === 1);
    await Bun.sleep(50);
    expect(received).toEqual([{ n: 1 }]);
    expect(logger.entries.filter((e) => e.level !== 'info')).toEqual([]);
    off();
    await until(async () => (await channelSubscribers('race')) === 0);
    await pubsub.close();
  });

  test('signed messages round-trip through Redis; unsigned ones are dropped', async () => {
    const logger = new MemoryLogger();
    const signingKey = crypto.getRandomValues(new Uint8Array(32));
    const pubsub = new RedisPubSub({ url, prefix, signingKey, logger });
    const received: unknown[] = [];
    const off = pubsub.subscribe('signed', (p) => received.push(p));
    await until(async () => (await channelSubscribers('signed')) === 1);
    await admin!.publish(`${prefix}signed`, JSON.stringify({ forged: true }));
    await pubsub.publishOrThrow('signed', { n: 1 });
    await until(() => received.length === 1);
    expect(received).toEqual([{ n: 1 }]);
    expect(logger.entries.some((e) => e.message.includes('signature'))).toBe(true);
    off();
    await pubsub.close();
  });

  test('close() with active subscriptions lets the process exit', async () => {
    const source = new URL('../src/redis-pubsub.ts', import.meta.url).pathname;
    const script = `
      import { RedisPubSub } from ${JSON.stringify(source)};
      const pubsub = new RedisPubSub({ url: ${JSON.stringify(url)}, prefix: ${JSON.stringify(prefix)} });
      pubsub.subscribe('exit', () => {});
      await Bun.sleep(300);
      await pubsub.close();
    `;
    const child = Bun.spawn(['bun', '-e', script], { stdout: 'ignore', stderr: 'inherit' });
    await until(async () => (await channelSubscribers('exit')) === 1, 3000);
    const exited = await Promise.race([child.exited, Bun.sleep(3000).then(() => 'still running')]);
    if (exited !== 0) child.kill('SIGKILL');
    expect(exited).toBe(0);
  }, 10_000);

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
