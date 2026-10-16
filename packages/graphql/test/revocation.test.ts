import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { APP_GUARD, type Ctx } from '@hpmws/http';
import {
  GraphQLSubscriptions,
  Int,
  PUBSUB,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    connectedAs?: string;
  }
}

let allowed = true;
const Allowed = (_ctx: ResolverCtx) => allowed;

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Subscription(() => Int, { topic: 'checked', guards: [Allowed], recheckGuards: true })
  checked() {}
  @Subscription(() => Int, { topic: 'once', guards: [Allowed] }) once() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
  allowed = true;
});

function open(started: Started, params: Record<string, unknown> = {}) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${started.app.url.port}/graphql`,
    'graphql-transport-ws',
  );
  const messages: { type: string; id?: string }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: params }));
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  const acked = until(() => messages.some((m) => m.type === 'connection_ack'));
  return { ws, messages, closed, acked };
}

describe('subscription revocation', () => {
  test('subscriptions.maxConnectionLifetime closes the socket with 4408', async () => {
    s = await startGraphQL([M], { subscriptions: { maxConnectionLifetime: 100 } });
    const socket = open(s);
    await socket.acked;
    expect((await socket.closed).code).toBe(4408);
  });

  test('recheckGuards re-runs root guards per event; a failure ends it with FORBIDDEN', async () => {
    s = await startGraphQL([M]);
    const pubsub = s.mod.get(PUBSUB);
    const sub = await s.app.graphqlSubscribe('subscription { checked }');
    await Bun.sleep(30);
    await pubsub.publish('checked', 1);
    expect((await sub.next()).value).toEqual({ data: { checked: 1 } });
    allowed = false;
    await pubsub.publish('checked', 2);
    const denied = await sub.next();
    expect(denied.value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await sub.next()).done).toBe(true);
    await sub.close();
  });

  test('without recheckGuards, guards run only at subscribe time', async () => {
    s = await startGraphQL([M]);
    const pubsub = s.mod.get(PUBSUB);
    const sub = await s.app.graphqlSubscribe('subscription { once }');
    await Bun.sleep(30);
    allowed = false;
    await pubsub.publish('once', 1);
    expect((await sub.next()).value).toEqual({ data: { once: 1 } });
    await sub.close();
  });

  test('GraphQLSubscriptions.closeWhere closes sockets by connection context', async () => {
    s = await startGraphQL([M], {
      subscriptions: {
        onConnect: (_http, params) =>
          typeof params.user === 'string' ? { connectedAs: params.user } : false,
      },
    });
    const ada = open(s, { user: 'ada' });
    const grace = open(s, { user: 'grace' });
    await Promise.all([ada.acked, grace.acked]);
    const service = s.mod.get(GraphQLSubscriptions);
    expect(service.closeWhere((c) => c.context.connectedAs === 'ada')).toBe(1);
    expect(await ada.closed).toEqual({ code: 1008, reason: 'Connection revoked' });
    expect(grace.ws.readyState).toBe(WebSocket.OPEN);
    expect(service.closeWhere((c) => c.http.req.url.endsWith('/graphql'), 4000, 'bye')).toBe(1);
    expect(await grace.closed).toEqual({ code: 4000, reason: 'bye' });
  });

  test('a socket whose onConnect is pending is re-checked once its init completes', async () => {
    const gate: { open?: () => void } = {};
    s = await startGraphQL([M], {
      subscriptions: {
        onConnect: async (_http, params) => {
          await new Promise<void>((resolve) => {
            gate.open = resolve;
          });
          return typeof params.user === 'string' ? { connectedAs: params.user } : false;
        },
      },
    });
    const ada = open(s, { user: 'ada' });
    await until(() => gate.open !== undefined);
    const service = s.mod.get(GraphQLSubscriptions);
    expect(service.closeWhere((c) => c.context.connectedAs === 'ada', 4001, 'revoked')).toBe(0);
    gate.open!();
    expect(await ada.closed).toEqual({ code: 4001, reason: 'revoked' });
    expect(ada.messages.some((m) => m.type === 'connection_ack')).toBe(false);
  });

  test('a socket that has not sent connection_init yet is re-checked too', async () => {
    s = await startGraphQL([M], {
      subscriptions: {
        onConnect: (_http, params) =>
          typeof params.user === 'string' ? { connectedAs: params.user } : false,
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${s.app.url.port}/graphql`, 'graphql-transport-ws');
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    await Bun.sleep(20);
    s.mod.get(GraphQLSubscriptions).closeWhere((c) => c.context.connectedAs === 'ada');
    ws.send(JSON.stringify({ type: 'connection_init', payload: { user: 'ada' } }));
    expect(await closed).toBe(1008);
  });

  test('a throwing predicate is logged and the other sockets are still revoked', async () => {
    s = await startGraphQL([M], {
      subscriptions: {
        onConnect: (_http, params) =>
          typeof params.user === 'string' ? { connectedAs: params.user } : false,
      },
    });
    const ada = open(s, { user: 'ada' });
    const grace = open(s, { user: 'grace' });
    await Promise.all([ada.acked, grace.acked]);
    const count = s.mod.get(GraphQLSubscriptions).closeWhere((c) => {
      if (c.context.connectedAs === 'grace') throw new Error('bad predicate');
      return true;
    });
    expect(count).toBe(1);
    expect((await ada.closed).code).toBe(1008);
    expect(grace.ws.readyState).toBe(WebSocket.OPEN);
    expect(s.mod.logs.some((e) => e.level === 'error' && e.message.includes('closeWhere'))).toBe(
      true,
    );
  });
});

describe('per-operation http state over WebSocket', () => {
  const marks: unknown[] = [];
  const fromUpgrade: unknown[] = [];
  @Resolver()
  class Marking {
    @Query(() => Int) q() {
      return 1;
    }
    @Subscription(() => Int, {
      topic: 'mark',
      guards: [
        (ctx: ResolverCtx) => {
          marks.push(ctx.http.state.mark);
          fromUpgrade.push(ctx.http.state.upgradeUser);
          ctx.http.state.mark = 'set by an earlier operation';
          return true;
        },
      ],
    })
    mark() {}
  }
  @Module({ providers: [Marking] })
  class MarkingModule {}

  test("each operation sees the upgrade state, never a sibling operation's writes", async () => {
    marks.length = 0;
    fromUpgrade.length = 0;
    const contexts: unknown[] = [];
    s = await startGraphQL(
      [MarkingModule],
      {
        // The README pattern: the context factory reads what a guard set on the upgrade.
        context: (http) => {
          contexts.push(http.state.upgradeUser);
          return { connectedAs: http.state.upgradeUser as string | undefined };
        },
      },
      [
        {
          provide: APP_GUARD,
          multi: true,
          useValue: (ctx: Ctx) => {
            if (ctx.upgrade) ctx.state.upgradeUser = 'ada';
            return true;
          },
        },
      ],
    );
    const socket = open(s);
    await socket.acked;
    for (const id of ['a', 'b']) {
      socket.ws.send(
        JSON.stringify({ id, type: 'subscribe', payload: { query: 'subscription { mark }' } }),
      );
    }
    await until(() => marks.length === 2);
    expect(marks).toEqual([undefined, undefined]);
    expect(fromUpgrade).toEqual(['ada', 'ada']);
    // The connection identity (closeWhere) and every operation saw the same upgrade state.
    expect(contexts.every((c) => c === 'ada')).toBe(true);
    const service = s.mod.get(GraphQLSubscriptions);
    expect(service.closeWhere((c) => c.context.connectedAs === 'ada')).toBe(1);
    await socket.closed;
  });
});

describe('GraphQLSubscriptions.closeWhere sees the merged connection context', () => {
  test('context(http) and the onConnect result are both visible; no match logs at debug', async () => {
    s = await startGraphQL([M], {
      context: (http) => ({ viewer: new URL(http.req.url).searchParams.get('viewer') }),
      subscriptions: {
        onConnect: (_http, params) =>
          typeof params.user === 'string' ? { connectedAs: params.user } : false,
      },
    });
    const connect = (viewer: string, user: string) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${s!.app.url.port}/graphql?viewer=${viewer}`,
        'graphql-transport-ws',
      );
      const messages: { type: string }[] = [];
      const closed = new Promise<number>((resolve) => {
        ws.onclose = (e) => resolve(e.code);
      });
      ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: { user } }));
      ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
      return { ws, closed, acked: until(() => messages.some((m) => m.type === 'connection_ack')) };
    };
    const ada = connect('v-ada', 'ada');
    const grace = connect('v-grace', 'grace');
    await Promise.all([ada.acked, grace.acked]);
    const service = s.mod.get(GraphQLSubscriptions);
    const seen: unknown[] = [];
    expect(
      service.closeWhere((c) => {
        seen.push({ ...c.context });
        return c.context.viewer === 'v-ada';
      }),
    ).toBe(1);
    expect(await ada.closed).toBe(1008);
    expect(seen).toContainEqual({ viewer: 'v-ada', connectedAs: 'ada' });
    expect(service.closeWhere((c) => c.context.viewer === 'nobody')).toBe(0);
    expect(
      s.mod.logs.some((e) => e.level === 'debug' && e.message.includes('matched no open sockets')),
    ).toBe(true);
    grace.ws.close();
  });
});

describe('subscriptions.refreshContext', () => {
  test('runs before each recheck: merged over the context, false ends with FORBIDDEN', async () => {
    let live: string | false = 'ada';
    const guardSaw: unknown[] = [];
    @Resolver()
    class Live {
      @Query(() => Int) q() {
        return 1;
      }
      @Subscription(() => Int, {
        topic: 'live',
        recheckGuards: true,
        guards: [
          (ctx: ResolverCtx) => {
            guardSaw.push(ctx.connectedAs);
            return true;
          },
        ],
      })
      live() {}
    }
    @Module({ providers: [Live] })
    class LiveModule {}
    s = await startGraphQL([LiveModule], {
      subscriptions: {
        onConnect: () => ({ connectedAs: 'connect-time' }),
        refreshContext: ({ context }) => {
          expect(context.connectedAs).toBeDefined();
          return live === false ? false : { connectedAs: live };
        },
      },
    });
    const pubsub = s.mod.get(PUBSUB);
    const sub = await s.app.graphqlSubscribe('subscription { live }');
    await Bun.sleep(30);
    await pubsub.publish('live', 1);
    expect((await sub.next()).value).toEqual({ data: { live: 1 } });
    // Subscribe-time guards saw the connect-time identity; the recheck saw the refreshed one.
    expect(guardSaw).toEqual(['connect-time', 'ada']);
    live = false;
    await pubsub.publish('live', 2);
    expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await sub.next()).done).toBe(true);
    await sub.close();
  });
});

describe('recheckGuards re-runs authorize guards', () => {
  test('an authorize-only subscription fails on the next event once refreshContext revokes', async () => {
    let role: string | false = 'reader';
    const sawArgs: unknown[] = [];
    const lower = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: String(value).toLowerCase() }),
      },
    };
    @Resolver()
    class Room {
      @Query(() => Int) q() {
        return 1;
      }
      @Subscription(() => Int, {
        args: { room: String },
        validate: { room: lower },
        topic: 'room',
        recheckGuards: true,
        authorize: [
          (ctx: ResolverCtx<{ room: string }>) => {
            sawArgs.push(ctx.args.room);
            return ctx.connectedAs === 'reader';
          },
        ],
      })
      room() {}
    }
    @Module({ providers: [Room] })
    class RoomModule {}
    s = await startGraphQL([RoomModule], {
      subscriptions: {
        onConnect: () => ({ connectedAs: 'reader' }),
        refreshContext: () => (role === false ? { connectedAs: 'nobody' } : { connectedAs: role }),
      },
    });
    const pubsub = s.mod.get(PUBSUB);
    const sub = await s.app.graphqlSubscribe('subscription { room(room: "LOBBY") }');
    await Bun.sleep(30);
    await pubsub.publish('room', 1);
    expect((await sub.next()).value).toEqual({ data: { room: 1 } });
    role = false;
    await pubsub.publish('room', 2);
    expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // Subscribe time, then each recheck, all against the validated (lowercased) argument.
    expect(sawArgs).toEqual(['lobby', 'lobby', 'lobby']);
    await sub.close();
  });
});
