import { afterEach, describe, expect, test } from 'bun:test';
import { Injectable, Module } from '@knead-js/core';
import {
  type BatchLoader,
  Int,
  PUBSUB,
  type PubSub,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

/** The role store the guards consult; tests revoke by changing it between events. */
const roles = new Map<string, string>();

@Injectable()
class RoleLoader implements BatchLoader<string, string> {
  async batch(ids: readonly string[]): Promise<string[]> {
    return ids.map((id) => roles.get(id) ?? 'none');
  }
}

/** Memoises the role in ctx.state, as a guard sharing work with resolvers would. */
const memoRole = (ctx: ResolverCtx) => {
  ctx.state.role ??= roles.get('u');
  return ctx.state.role;
};
const StateAdmin = (ctx: ResolverCtx) => memoRole(ctx) === 'admin';
const LoaderAdmin = async (ctx: ResolverCtx) =>
  (await ctx.loader(RoleLoader).load('u')) === 'admin';

let rechecks = 0;
const Counting = (ctx: ResolverCtx) => {
  ctx.state.recheck = ++rechecks;
  return true;
};

const filterSaw: unknown[] = [];

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }

  @Subscription(() => Int, { topic: 'state', guards: [StateAdmin], recheckGuards: true })
  byState(ctx: ResolverCtx) {
    // The event's resolvers memoise too: the next event's recheck must not reuse it.
    memoRole(ctx);
  }

  @Subscription(() => Int, { topic: 'loader', guards: [LoaderAdmin], recheckGuards: true })
  async byLoader(ctx: ResolverCtx) {
    await ctx.loader(RoleLoader).load('u');
  }

  @Subscription(() => Int, {
    topic: 'filtered',
    guards: [
      (ctx: ResolverCtx) => {
        ctx.state.mark = 'subscribe';
        return true;
      },
    ],
    filter: ({ payload, ctx }) => {
      filterSaw.push(ctx.state.mark);
      ctx.state.mark = `filter ${payload}`;
      return true;
    },
  })
  filtered(ctx: ResolverCtx<{}, number>) {
    const mark = ctx.state.mark;
    ctx.state.mark = 'resolver';
    return mark === `filter ${ctx.parent}` ? ctx.parent : -1;
  }

  @Subscription(() => Int, { topic: 'counted', guards: [Counting], recheckGuards: true })
  counted(ctx: ResolverCtx) {
    return ctx.state.recheck as number;
  }
}

@Module({ providers: [RoleLoader, R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
  roles.clear();
  rechecks = 0;
  filterSaw.length = 0;
});

const subscribers = (started: Started, topic: string) =>
  (started.mod.get(PUBSUB) as PubSub).getSubscriberCount(topic);

describe('per-event state of a subscription', () => {
  for (const [field, topic] of [
    ['byState', 'state'],
    ['byLoader', 'loader'],
  ] as const) {
    test(`a recheck guard memoising through ${topic} sees a revocation before event 1`, async () => {
      roles.set('u', 'admin');
      s = await startGraphQL([M]);
      const sub = await s.app.graphqlSubscribe(`subscription { ${field} }`);
      await until(() => subscribers(s!, topic) === 1);
      roles.set('u', 'user');
      s.mod.get(PUBSUB).publish(topic, 1);
      expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      await sub.close();
    });

    test(`a recheck guard memoising through ${topic} sees a revocation after event 1`, async () => {
      roles.set('u', 'admin');
      s = await startGraphQL([M]);
      const sub = await s.app.graphqlSubscribe(`subscription { ${field} }`);
      await until(() => subscribers(s!, topic) === 1);
      s.mod.get(PUBSUB).publish(topic, 1);
      expect((await sub.next()).value).toEqual({ data: { [field]: 1 } });
      roles.set('u', 'user');
      s.mod.get(PUBSUB).publish(topic, 2);
      expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      await sub.close();
    });
  }

  test("the filter sees fresh state, and the event's resolver sees what the filter set", async () => {
    s = await startGraphQL([M]);
    const sub = await s.app.graphqlSubscribe('subscription { filtered }');
    await until(() => subscribers(s!, 'filtered') === 1);
    s.mod.get(PUBSUB).publish('filtered', 1);
    expect((await sub.next()).value).toEqual({ data: { filtered: 1 } });
    s.mod.get(PUBSUB).publish('filtered', 2);
    expect((await sub.next()).value).toEqual({ data: { filtered: 2 } });
    expect(filterSaw).toEqual([undefined, undefined]);
    await sub.close();
  });

  test("the event's resolver sees the state its recheck set", async () => {
    s = await startGraphQL([M]);
    const sub = await s.app.graphqlSubscribe('subscription { counted }');
    await until(() => subscribers(s!, 'counted') === 1);
    s.mod.get(PUBSUB).publish('counted', 0);
    // Subscribe time ran the guard once (1); event 1's recheck is the second run.
    expect((await sub.next()).value).toEqual({ data: { counted: 2 } });
    s.mod.get(PUBSUB).publish('counted', 0);
    expect((await sub.next()).value).toEqual({ data: { counted: 3 } });
    await sub.close();
  });
});
