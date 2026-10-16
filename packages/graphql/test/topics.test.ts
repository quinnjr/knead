import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import type { PubSub } from '@leaven-graphql/ws';
import { ID, Int, PUBSUB, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Subscription(() => Int, {
    args: { room: ID },
    topic: (ctx) => [`room.${ctx.args.room}`, 'lobby'],
  })
  room() {}
  @Subscription(() => Int, { topic: 'all.*' }) everything() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('topic safety', () => {
  for (const room of ['*', '#', 'a.*', 'x#y']) {
    test(`a topic function producing a wildcard (${room}) is BAD_USER_INPUT`, async () => {
      s = await startGraphQL([M]);
      const sub = await s.app.graphqlSubscribe('subscription($r: ID!) { room(room: $r) }', {
        variables: { r: room },
      });
      const first = await sub.next();
      expect(first.value?.errors?.[0]).toMatchObject({
        message: 'Subscription topics cannot contain "*" or "#".',
        extensions: { code: 'BAD_USER_INPUT' },
      });
      await sub.close();
      expect((s.mod.get(PUBSUB) as PubSub).getTopics()).toEqual([]);
    });
  }

  test('a computed topic longer than 256 characters is BAD_USER_INPUT', async () => {
    s = await startGraphQL([M]);
    const sub = await s.app.graphqlSubscribe('subscription($r: ID!) { room(room: $r) }', {
      variables: { r: 'x'.repeat(252) }, // "room." + 252 = 257
    });
    const first = await sub.next();
    expect(first.value?.errors?.[0]).toMatchObject({
      message: 'Subscription topics cannot be longer than 256 characters.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await sub.close();
    expect((s.mod.get(PUBSUB) as PubSub).getTopics()).toEqual([]);
  });

  test('ordinary topics subscribe; static topics may use wildcards', async () => {
    s = await startGraphQL([M]);
    const sub = await s.app.graphqlSubscribe('subscription { room(room: "r1") }');
    await Bun.sleep(30);
    expect((s.mod.get(PUBSUB) as PubSub).getTopics().sort()).toEqual(['lobby', 'room.r1']);
    await sub.close();
    const all = await s.app.graphqlSubscribe('subscription { everything }');
    await Bun.sleep(30);
    expect((s.mod.get(PUBSUB) as PubSub).getTopics()).toContain('all.*');
    await all.close();
  });
});
