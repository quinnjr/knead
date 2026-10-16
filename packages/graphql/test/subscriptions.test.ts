import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
import {
  Field,
  ID,
  Int,
  Mutation,
  ObjectType,
  PUBSUB,
  type PubSub,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    tenant?: string;
  }
}

@ObjectType()
class Message {
  @Field(() => ID) room!: string;
  @Field(() => String) text!: string;
}

@Resolver()
class ChatResolver {
  readonly #pubsub = inject(PUBSUB);

  @Query(() => Int) ping() {
    return 1;
  }

  @Mutation(() => Boolean, { args: { room: ID, text: String } })
  send(ctx: ResolverCtx<{ room: string; text: string }>) {
    this.#pubsub.publish('messages', { room: ctx.args.room, text: ctx.args.text });
    return true;
  }

  @Subscription(() => Message, {
    args: { room: ID },
    topic: 'messages',
    filter: ({ payload, args }) => payload.room === args.room,
  })
  messages() {}

  @Subscription(() => String, {
    topic: (ctx: ResolverCtx) => `tenant:${ctx.tenant}`,
    resolve: (payload: { text: string }) => payload.text,
  })
  shout(ctx: ResolverCtx<{}, string>) {
    return ctx.parent.toUpperCase();
  }
}

@Module({ providers: [ChatResolver] })
class ChatModule {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

const subscribers = (s: Started, topic: string) =>
  (s.mod.get(PUBSUB) as PubSub).getSubscriberCount(topic);

describe('subscriptions over WebSocket', () => {
  test('events are filtered per subscription', async () => {
    s = await startGraphQL([ChatModule]);
    const sub = await s.app.graphqlSubscribe<{ messages: Message }>(
      'subscription($room: ID!) { messages(room: $room) { room text } }',
      { variables: { room: 'a' } },
    );
    await until(() => subscribers(s!, 'messages') === 1);
    await s.app.graphql('mutation { send(room: "b", text: "skip") }');
    await s.app.graphql('mutation { send(room: "a", text: "hello") }');
    const first = await sub.next();
    expect(first.value).toEqual({ data: { messages: { room: 'a', text: 'hello' } } });
    await sub.close();
    await until(() => subscribers(s!, 'messages') === 0);
  });

  test('topic functions see the context; resolve and the method transform the payload', async () => {
    s = await startGraphQL([ChatModule], { context: () => ({ tenant: 't1' }) });
    const sub = await s.app.graphqlSubscribe<{ shout: string }>('subscription { shout }');
    await until(() => subscribers(s!, 'tenant:t1') === 1);
    s.mod.get(PUBSUB).publish('tenant:t1', { text: 'hi' });
    expect((await sub.next()).value).toEqual({ data: { shout: 'HI' } });
    await sub.close();
  });

  test('onConnect: false closes with 4403; an object is merged into the context', async () => {
    s = await startGraphQL([ChatModule], {
      subscriptions: {
        onConnect: (_http, params) => (params.token === 'ok' ? { tenant: 'from-connect' } : false),
      },
    });
    await expect(s.app.graphqlSubscribe('subscription { shout }')).rejects.toThrow('4403');
    const sub = await s.app.graphqlSubscribe<{ shout: string }>('subscription { shout }', {
      connectionParams: { token: 'ok' },
    });
    await until(() => subscribers(s!, 'tenant:from-connect') === 1);
    s.mod.get(PUBSUB).publish('tenant:from-connect', { text: 'yo' });
    expect((await sub.next()).value).toEqual({ data: { shout: 'YO' } });
    await sub.close();
  });

  test('a throwing onConnect rejects without leaking the message', async () => {
    s = await startGraphQL([ChatModule], {
      subscriptions: {
        onConnect: () => {
          throw new Error('secret detail');
        },
      },
    });
    const error = await s.app.graphqlSubscribe('subscription { shout }').catch((e: Error) => e);
    expect(String(error)).toContain('4403');
    expect(String(error)).not.toContain('secret detail');
  });

  test('upgrades without the graphql-transport-ws subprotocol are rejected', async () => {
    s = await startGraphQL([ChatModule]);
    const url = new URL('/graphql', s.app.url);
    url.protocol = 'ws:';
    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(url.toString());
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('error');
    });
    expect(result).toBe('error');
  });

  test('closing the app closes subscription sockets and their pubsub subscriptions', async () => {
    s = await startGraphQL([ChatModule]);
    await s.app.graphqlSubscribe('subscription($room: ID!) { messages(room: $room) { text } }', {
      variables: { room: 'z' },
    });
    await until(() => subscribers(s!, 'messages') === 1);
    const pubsub = s.mod.get(PUBSUB) as PubSub;
    await s.mod.close();
    s = undefined;
    await until(() => pubsub.getSubscriberCount('messages') === 0);
  });
});
