import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
import {
  type BatchLoader,
  Field,
  ID,
  Int,
  ObjectType,
  PUBSUB,
  type PubSub,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

class Names {
  readonly byId = new Map([['a', 'Ada']]);
  batches = 0;
}

class NameLoader implements BatchLoader<string, string> {
  readonly #names = inject(Names);
  async batch(ids: readonly string[]): Promise<(string | Error)[]> {
    this.#names.batches++;
    return ids.map((id) => this.#names.byId.get(id) ?? new Error(`no ${id}`));
  }
}

@ObjectType()
class Event {
  @Field(() => ID) authorId!: string;
}

@Resolver(() => Event)
class EventResolver {
  @Query(() => Int) n() {
    return 1;
  }

  @Subscription(() => Event, { topic: 'events' })
  events() {}

  @Subscription(() => Event, {
    topic: 'events',
    filter: () => {
      throw new Error('filter secret');
    },
  })
  broken() {}

  @ResolveField(() => String)
  author(ctx: ResolverCtx<{}, Event>) {
    ctx.state.seen = ((ctx.state.seen as number | undefined) ?? 0) + 1;
    return ctx.loader(NameLoader).load(ctx.parent.authorId);
  }

  @ResolveField(() => Int)
  seen(ctx: ResolverCtx<{}, Event>) {
    return (ctx.state.seen as number | undefined) ?? 0;
  }
}

@Module({ providers: [Names, NameLoader, EventResolver] })
class EventsModule {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

const count = (s: Started) => (s.mod.get(PUBSUB) as PubSub).getSubscriberCount('events');

describe('subscription events', () => {
  test('each event gets fresh DataLoaders and fresh state', async () => {
    s = await startGraphQL([EventsModule]);
    const names = s.mod.get(Names);
    const sub = await s.app.graphqlSubscribe('subscription { events { author seen } }');
    await until(() => count(s!) === 1);
    s.mod.get(PUBSUB).publish('events', { authorId: 'a' });
    expect((await sub.next()).value).toEqual({ data: { events: { author: 'Ada', seen: 1 } } });
    names.byId.set('a', 'Ada Lovelace');
    s.mod.get(PUBSUB).publish('events', { authorId: 'a' });
    expect((await sub.next()).value).toEqual({
      data: { events: { author: 'Ada Lovelace', seen: 1 } },
    });
    expect(names.batches).toBe(2);
    await sub.close();
  });

  test('a throwing filter is logged and masked', async () => {
    s = await startGraphQL([EventsModule]);
    const sub = await s.app.graphqlSubscribe('subscription { broken { authorId } }');
    await until(() => count(s!) === 1);
    s.mod.get(PUBSUB).publish('events', { authorId: 'a' });
    const result = await sub.next();
    expect(JSON.stringify(result.value)).not.toContain('filter secret');
    expect(result.value?.errors?.[0]?.message).toBe('Internal server error');
    expect(s.mod.logs.some((e) => e.level === 'error')).toBe(true);
  });

  test('a throwing context factory over WebSocket is logged and masked', async () => {
    s = await startGraphQL([EventsModule], {
      context: (http) => {
        if (http.req.headers.get('upgrade')) throw new Error('context secret');
        return {};
      },
    });
    const sub = await s.app.graphqlSubscribe('subscription { events { authorId } }');
    const result = await sub.next();
    expect(JSON.stringify(result.value)).not.toContain('context secret');
    expect(result.value?.errors?.[0]?.message).toBe('Internal server error');
  });
});
