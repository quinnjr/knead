import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import type { TestApp } from '@hpmws/testing';
import type { PubSub } from '@leaven-graphql/ws';
import { Int, PUBSUB, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL, until } from './helpers.js';

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

interface Raw {
  ws: WebSocket;
  messages: { type: string; id?: string }[];
  closed: Promise<number>;
  send(message: object): void;
  acked(): Promise<void>;
}

function connect(app: TestApp): Promise<Raw> {
  const ws = new WebSocket(`ws://127.0.0.1:${app.url.port}/graphql`, 'graphql-transport-ws');
  const messages: Raw['messages'] = [];
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve(e.code);
  });
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  const raw: Raw = {
    ws,
    messages,
    closed,
    send: (message) => ws.send(JSON.stringify(message)),
    acked: () => until(() => messages.some((m) => m.type === 'connection_ack')),
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(raw);
    ws.onerror = () => reject(new Error('WebSocket error'));
  });
}

const sleepyContext = {
  context: async () => {
    await Bun.sleep(40);
    return {};
  },
};
const subscribers = (started: Started) =>
  (started.mod.get(PUBSUB) as PubSub).getSubscriberCount('t');

describe('WebSocket races', () => {
  test('a second connection_init is closed with 4429 before onConnect runs again', async () => {
    let calls = 0;
    s = await startGraphQL([M], {
      subscriptions: {
        onConnect: async () => {
          calls++;
          await Bun.sleep(30);
          return true;
        },
      },
    });
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    raw.send({ type: 'connection_init' });
    expect(await raw.closed).toBe(4429);
    expect(calls).toBe(1);
  });

  test('a subscribe that completes after the socket closed is returned at once', async () => {
    s = await startGraphQL([M], sleepyContext);
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    await raw.acked();
    raw.send({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } });
    await Bun.sleep(5);
    raw.ws.close();
    await raw.closed;
    await Bun.sleep(100);
    expect(subscribers(s)).toBe(0);
  });

  test('complete before the subscription is active cancels it', async () => {
    s = await startGraphQL([M], sleepyContext);
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    await raw.acked();
    raw.send({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } });
    await Bun.sleep(5);
    raw.send({ id: '1', type: 'complete' });
    await Bun.sleep(100);
    expect(subscribers(s)).toBe(0);
    raw.ws.close();
  });

  test('reusing an id returns the earlier iterator; closing returns every iterator', async () => {
    s = await startGraphQL([M], sleepyContext);
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    await raw.acked();
    raw.send({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } });
    await Bun.sleep(5);
    raw.send({ id: '1', type: 'complete' });
    raw.send({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } });
    raw.send({ id: '2', type: 'subscribe', payload: { query: 'subscription { t }' } });
    await until(() => subscribers(s!) === 2);
    await Bun.sleep(50);
    expect(subscribers(s)).toBe(2);
    raw.ws.close();
    await raw.closed;
    await until(() => subscribers(s!) === 0);
  });
});

describe('http WebSocket limits apply to the subscription endpoint', () => {
  test('subscriptions.messageRate closes a flooding socket with 1008', async () => {
    s = await startGraphQL([M], { subscriptions: { messageRate: { limit: 3, windowMs: 60_000 } } });
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    for (let i = 0; i < 5; i++) raw.send({ type: 'ping' });
    expect(await raw.closed).toBe(1008);
  });

  test('an oversized message drops the connection (maxPayloadLength)', async () => {
    s = await startGraphQL([M]);
    const raw = await connect(s.app);
    raw.send({ type: 'connection_init' });
    await raw.acked();
    raw.send({
      id: '1',
      type: 'subscribe',
      payload: { query: `subscription { t }${' '.repeat(70_000)}` },
    });
    expect(await raw.closed).not.toBe(1000);
    expect(raw.messages.some((m) => m.id === '1')).toBe(false);
  });
});
