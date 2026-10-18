import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import type { Ctx, ListenOptions } from '@knead-js/http';
import {
  type GraphQLModuleOptions,
  GraphQLSubscriptions,
  Int,
  PUBSUB,
  type PubSub,
  Query,
  Resolver,
  Subscription,
} from '../src/index.js';
import { readSse, type SseEvent, type Started, startGraphQL, until } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    sseUser?: string;
  }
}

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

async function start(
  options: GraphQLModuleOptions = {},
  listen: ListenOptions = {},
): Promise<Started> {
  s = await startGraphQL([M], options, [], listen);
  return s;
}

/** onConnect identifies the stream by its `x-user` header. */
const byUser: GraphQLModuleOptions = {
  subscriptions: { onConnect: (http: Ctx) => ({ sseUser: http.req.headers.get('x-user') ?? '' }) },
};

function send(user = 'u'): Promise<Response> {
  return fetch(new URL('/graphql', s!.app.url), {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify({ query: 'subscription { t }' }),
  });
}

const subscribers = () => (s!.mod.get(PUBSUB) as PubSub).getSubscriberCount('t');
const closeWhere = (predicate: Parameters<GraphQLSubscriptions['closeWhere']>[0]) =>
  s!.mod.get(GraphQLSubscriptions).closeWhere(predicate);

/** Opens a subscription stream as `user` and waits until it listens. */
async function open(user = 'u') {
  const before = subscribers();
  const res = await send(user);
  expect(res.status).toBe(200);
  const events = readSse(res);
  await until(() => subscribers() === before + 1);
  return events;
}

/** Every remaining event of `events` (the stream must end). */
async function rest(events: AsyncIterableIterator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const debugNothing = () =>
  s!.mod.logs.some((e) => e.level === 'debug' && e.message.includes('matched no open'));

describe('SSE revocation and lifetime', () => {
  test('closeWhere ends a matching SSE stream without complete', async () => {
    await start(byUser);
    const events = await open('ada');
    expect(closeWhere((c) => c.context.sseUser === 'ada')).toBe(1);
    expect(await rest(events)).toEqual([]);
    // The iterator was returned: its topic subscription is gone.
    await until(() => subscribers() === 0);
    expect(debugNothing()).toBe(false);
  });

  test('closeWhere returns the SSE count and leaves non-matching streams open', async () => {
    await start(byUser);
    const ada = await open('ada');
    const ada2 = await open('ada');
    const grace = await open('grace');
    expect(closeWhere((c) => c.context.sseUser === 'ada')).toBe(2);
    expect(await rest(ada)).toEqual([]);
    expect(await rest(ada2)).toEqual([]);
    await until(() => subscribers() === 1);
    s!.mod.get(PUBSUB).publish('t', 7);
    expect((await grace.next()).value).toEqual({ event: 'next', data: '{"data":{"t":7}}' });
    expect(closeWhere(() => false)).toBe(0);
    expect(debugNothing()).toBe(true);
    await grace.return!();
  });

  test('a revocation issued while onConnect is pending ends the stream when onConnect resolves', async () => {
    let resolve!: (value: { sseUser: string }) => void;
    let calls = 0;
    await start({
      subscriptions: {
        onConnect: () => {
          calls++;
          return new Promise((r) => {
            resolve = r;
          });
        },
      },
    });
    const pending = send('ada');
    await until(() => calls === 1);
    // Its identity is not known yet: it is checked when onConnect settles.
    expect(closeWhere((c) => c.context.sseUser === 'ada')).toBe(0);
    resolve({ sseUser: 'ada' });
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({
      errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
    });
    expect(subscribers()).toBe(0);
  });

  test('a kept predicate that does not match lets the stream start', async () => {
    let resolve!: (value: { sseUser: string }) => void;
    await start({
      subscriptions: {
        onConnect: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    const pending = send('grace');
    await until(() => resolve !== undefined);
    closeWhere((c) => c.context.sseUser === 'ada');
    resolve({ sseUser: 'grace' });
    const res = await pending;
    expect(res.status).toBe(200);
    const events = readSse(res);
    await until(() => subscribers() === 1);
    await events.return!();
  });

  test('past maxPendingRevocations a pending stream is ended (fail closed)', async () => {
    let calls = 0;
    await start(
      {
        subscriptions: {
          onConnect: () => {
            calls++;
            return new Promise(() => {});
          },
        },
      },
      { websocket: { maxPendingRevocations: 2 } },
    );
    const pending = send('grace');
    await until(() => calls === 1);
    closeWhere(() => false);
    closeWhere(() => false);
    // The third cannot be kept: the stream ends rather than escape it.
    closeWhere(() => false);
    expect((await pending).status).toBe(503);
  });

  test('a throwing predicate is logged and skipped', async () => {
    await start(byUser);
    const ada = await open('ada');
    const grace = await open('grace');
    const count = closeWhere((c) => {
      if (c.context.sseUser === 'grace') throw new Error('bad predicate');
      return true;
    });
    expect(count).toBe(1);
    expect(await rest(ada)).toEqual([]);
    expect(s!.mod.logs.some((e) => e.level === 'error' && e.message.includes('closeWhere'))).toBe(
      true,
    );
    await until(() => subscribers() === 1);
    s!.mod.get(PUBSUB).publish('t', 1);
    expect((await grace.next()).value).toEqual({ event: 'next', data: '{"data":{"t":1}}' });
    await grace.return!();
  });

  test('maxConnectionLifetime ends an SSE stream', async () => {
    await start({ subscriptions: { maxConnectionLifetime: 100 } });
    const started = Date.now();
    const events = await open();
    expect(await rest(events)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(300);
    await until(() => subscribers() === 0);
  });
});
