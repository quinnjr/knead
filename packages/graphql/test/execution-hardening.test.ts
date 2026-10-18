import { afterEach, describe, expect, test } from 'bun:test';
import { Injectable, InjectionToken, inject, Module } from '@knead-js/core';
import type { Ctx } from '@knead-js/http';
import { OperationContext } from '../src/context.js';
import {
  type BatchLoader,
  Field,
  GraphQLRuntime,
  ID,
  InputType,
  Int,
  InterfaceType,
  ObjectType,
  PUBSUB,
  type PubSub,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
  SchemaBuildError,
  Subscription,
  UseFieldGuards,
} from '../src/index.js';
import { MAX_SUBSCRIPTION_TOPICS } from '../src/runtime.js';
import { type Started, startGraphQL } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    connectedAs?: string;
  }
}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('@ResolveField on subclasses and interfaces', () => {
  test('an @ObjectType subclass of the resolver type gets its @ResolveField and guards', async () => {
    let calls = 0;
    @ObjectType()
    class User {
      @Field(() => ID) id!: string;
      @Field(() => String, { nullable: true }) email?: string | null;
    }
    @ObjectType()
    class Admin extends User {
      @Field(() => Int) level!: number;
    }
    @Resolver(() => User)
    class Users {
      @Query(() => User) user() {
        return { id: 'u', email: 'u@x' };
      }
      @Query(() => Admin) admin() {
        return { id: 'a', email: 'raw@x', level: 9 };
      }
      @ResolveField(() => String, { nullable: true, guards: [() => false] }) email() {
        calls++;
        return 'resolved';
      }
    }
    @Module({ providers: [Users] })
    class M {}
    s = await startGraphQL([M], { orphanedTypes: [Admin] });
    const res = await s.app.graphql('{ admin { id email level } }');
    expect(res.data).toEqual({ admin: { id: 'a', email: null, level: 9 } });
    expect(res.errors?.[0]).toMatchObject({
      path: ['admin', 'email'],
      extensions: { code: 'FORBIDDEN' },
    });
    expect(calls).toBe(0);
  });

  test('the nearest class wins when a subclass has its own @ResolveField', async () => {
    @ObjectType()
    class Base {
      @Field(() => ID) id!: string;
    }
    @ObjectType()
    class Derived extends Base {}
    @Resolver(() => Base)
    class BaseResolver {
      @Query(() => Derived) derived() {
        return { id: 'd' };
      }
      @ResolveField(() => String) label() {
        return 'base';
      }
    }
    @Resolver(() => Derived)
    class DerivedResolver {
      @ResolveField(() => String) label() {
        return 'derived';
      }
    }
    @Module({ providers: [BaseResolver, DerivedResolver] })
    class M {}
    s = await startGraphQL([M]);
    expect((await s.app.graphql('{ derived { id label } }')).data).toEqual({
      derived: { id: 'd', label: 'derived' },
    });
  });

  test('@ResolveField on an @InterfaceType target is a SchemaBuildError', async () => {
    @InterfaceType({ resolveType: () => 'Thing' })
    class Node {
      @Field(() => ID) id!: string;
    }
    @Resolver(() => Node)
    class Nodes {
      @Query(() => Int) n() {
        return 1;
      }
      @ResolveField(() => String) secret() {
        return 's';
      }
    }
    @Module({ providers: [Nodes] })
    class M {}
    const failure = await startGraphQL([M]).catch((e) => e);
    expect(failure).toBeInstanceOf(SchemaBuildError);
    expect((failure as Error).message).toBe(
      'Nodes.secret: @ResolveField on @InterfaceType Node is not supported; resolve it on each ' +
        'concrete type.',
    );
  });
});

describe('@UseFieldGuards on types that cannot run them', () => {
  test('on an @InterfaceType is a SchemaBuildError', async () => {
    @InterfaceType({ resolveType: () => 'Account' })
    @UseFieldGuards(() => false)
    class Node {
      @Field(() => Int) id!: number;
    }
    @ObjectType({ implements: () => [Node] })
    class Account {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Node, { nullable: true }) node() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    const failure = await startGraphQL([M], { orphanedTypes: [Account] }).catch((e) => e);
    expect(failure).toBeInstanceOf(SchemaBuildError);
    expect((failure as Error).message).toBe(
      '@UseFieldGuards on @InterfaceType Node has no effect; put it on the implementing object ' +
        'types.',
    );
  });

  test('on an @InputType is a SchemaBuildError', async () => {
    @InputType()
    @UseFieldGuards(() => false)
    class Filter {
      @Field(() => Int) min!: number;
    }
    @Resolver()
    class R {
      @Query(() => Int, { args: { filter: Filter } }) n() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    const failure = await startGraphQL([M]).catch((e) => e);
    expect(failure).toBeInstanceOf(SchemaBuildError);
    expect((failure as Error).message).toBe('@UseFieldGuards on @InputType Filter has no effect.');
  });
});

describe('subscription fields outside a subscription', () => {
  test('executing a subscription document runs neither guards nor the method', async () => {
    let calls = 0;
    let guarded = 0;
    @Resolver()
    class R {
      @Query(() => Int) n() {
        return 1;
      }
      @Subscription(() => Int, {
        topic: 't',
        guards: [
          () => {
            guarded++;
            return false;
          },
        ],
      })
      t() {
        calls++;
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    const runtime = s.mod.get(GraphQLRuntime);
    const op = new OperationContext({} as Ctx, {}, ['query', 'subscription']);
    const { response } = await runtime.executor.execute({ query: 'subscription { t }' }, op);
    expect(response.errors?.[0]).toMatchObject({
      message: 'Subscriptions are only available over WebSocket.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(calls).toBe(0);
    expect(guarded).toBe(0);
  });
});

describe('computed subscription topics', () => {
  @Resolver()
  class Topics {
    @Query(() => Int) n() {
      return 1;
    }
    @Subscription(() => Int, {
      args: { n: Int },
      topic: (ctx) => Array.from({ length: ctx.args.n }, (_, i) => `t.${i}`),
    })
    many() {}
    @Subscription(() => Int, { args: { n: Int }, topic: (ctx) => Array(ctx.args.n).fill('same') })
    repeated() {}
  }
  @Module({ providers: [Topics] })
  class TopicsModule {}

  test(`more than ${MAX_SUBSCRIPTION_TOPICS} topics is BAD_USER_INPUT`, async () => {
    s = await startGraphQL([TopicsModule]);
    const sub = await s.app.graphqlSubscribe(
      `subscription { many(n: ${MAX_SUBSCRIPTION_TOPICS + 1}) }`,
    );
    expect((await sub.next()).value?.errors?.[0]).toMatchObject({
      message: `A subscription cannot listen to more than ${MAX_SUBSCRIPTION_TOPICS} topics.`,
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await sub.close();
    expect((s.mod.get(PUBSUB) as PubSub).getTopics()).toEqual([]);
  });

  test('duplicate topics are subscribed once and do not count toward the limit', async () => {
    s = await startGraphQL([TopicsModule]);
    const pubsub = s.mod.get(PUBSUB) as PubSub;
    const sub = await s.app.graphqlSubscribe(
      `subscription { repeated(n: ${MAX_SUBSCRIPTION_TOPICS * 5}) }`,
    );
    await Bun.sleep(30);
    expect(pubsub.getTopics()).toEqual(['same']);
    expect(pubsub.getSubscriberCount('same')).toBe(1);
    await pubsub.publish('same', 1);
    expect((await sub.next()).value).toEqual({ data: { repeated: 1 } });
    await sub.close();
  });
});

describe('subscription filters and refreshContext', () => {
  test('the filter sees the identity refreshContext set at the previous recheck', async () => {
    let next = 'ada';
    const filterSaw: unknown[] = [];
    @Resolver()
    class Live {
      @Query(() => Int) q() {
        return 1;
      }
      @Subscription(() => Int, {
        topic: 'live',
        recheckGuards: true,
        filter: ({ ctx }) => {
          filterSaw.push(ctx.connectedAs);
          return true;
        },
      })
      live() {}
    }
    @Module({ providers: [Live] })
    class LiveModule {}
    s = await startGraphQL([LiveModule], {
      subscriptions: {
        onConnect: () => ({ connectedAs: 'connect-time' }),
        refreshContext: () => ({ connectedAs: next }),
      },
    });
    const pubsub = s.mod.get(PUBSUB);
    const sub = await s.app.graphqlSubscribe('subscription { live }');
    await Bun.sleep(30);
    await pubsub.publish('live', 1);
    expect((await sub.next()).value).toEqual({ data: { live: 1 } });
    next = 'grace';
    await pubsub.publish('live', 2);
    expect((await sub.next()).value).toEqual({ data: { live: 2 } });
    expect(filterSaw).toEqual(['connect-time', 'ada']);
    await sub.close();
  });
});

describe('ctx.loader per module', () => {
  test('the same BatchLoader class in two modules gets one DataLoader per module', async () => {
    const PREFIX = new InjectionToken<string>('prefix');
    @Injectable()
    class Prefixer implements BatchLoader<string, string> {
      readonly #prefix = inject(PREFIX);
      async batch(keys: readonly string[]) {
        return keys.map((k) => `${this.#prefix}:${k}`);
      }
    }
    @Resolver()
    class A {
      @Query(() => String) a(ctx: ResolverCtx) {
        return ctx.loader(Prefixer).load('x');
      }
    }
    @Resolver()
    class B {
      @Query(() => String) b(ctx: ResolverCtx) {
        return ctx.loader(Prefixer).load('x');
      }
    }
    @Module({ providers: [A, Prefixer, { provide: PREFIX, useValue: 'a' }] })
    class ModA {}
    @Module({ providers: [B, Prefixer, { provide: PREFIX, useValue: 'b' }] })
    class ModB {}
    s = await startGraphQL([ModA, ModB]);
    expect((await s.app.graphql('{ a b }')).data).toEqual({ a: 'a:x', b: 'b:x' });
  });
});

describe('defaultDeny and authorize guards', () => {
  test('an authorize guard counts as the field own guard', async () => {
    let allow = true;
    @Resolver()
    class R {
      @Query(() => Int, { authorize: [() => allow] }) n() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M], { defaultDeny: true });
    expect((await s.app.graphql('{ n }')).data).toEqual({ n: 1 });
    allow = false;
    expect((await s.app.graphql('{ n }')).errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
