import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
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
        onConnect: (_http, params) => ({ user: params.user }),
      },
    });
    const ada = open(s, { user: 'ada' });
    const grace = open(s, { user: 'grace' });
    await Promise.all([ada.acked, grace.acked]);
    const service = s.mod.get(GraphQLSubscriptions);
    expect(service.closeWhere((c) => c.context.user === 'ada')).toBe(1);
    expect(await ada.closed).toEqual({ code: 1008, reason: 'Connection revoked' });
    expect(grace.ws.readyState).toBe(WebSocket.OPEN);
    expect(service.closeWhere((c) => c.http.req.url.endsWith('/graphql'), 4000, 'bye')).toBe(1);
    expect(await grace.closed).toEqual({ code: 4000, reason: 'bye' });
  });
});
