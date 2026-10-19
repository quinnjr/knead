import { afterEach, describe, expect, test } from 'bun:test';
import { Module, type Provider } from '@knead-js/core';
import { APP_GUARD, type Ctx, type ListenOptions } from '@knead-js/http';
import { readSse, type SseEvent, Test } from '@knead-js/testing';
import { DocumentCache, type SubscriptionIterator } from '@leaven-graphql/core';
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLRuntime,
  Int,
  Mutation,
  PUBSUB,
  type PubSub,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { wantsEventStream } from '../src/sse.js';
import { type Started, startGraphQL, until, upgradeStatus } from './helpers.js';

declare module '../src/index.js' {
  interface GraphQLContext {
    sseTenant?: string;
  }
}

const roles = new Map<string, string>();
let bumps = 0;
const filterSaw: unknown[] = [];
const Admin = (ctx: ResolverCtx) => {
  ctx.state.role ??= roles.get('u');
  return ctx.state.role === 'admin';
};

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Mutation(() => Int) bump() {
    return ++bumps;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
  @Subscription(() => String, { topic: 'tenant', resolve: () => '' })
  whoami(ctx: ResolverCtx) {
    return String(ctx.sseTenant);
  }
  @Subscription(() => Int, { topic: 'denied', authorize: [() => false] }) denied() {}
  @Subscription(() => Int, { topic: 'role', guards: [Admin], recheckGuards: true }) byRole() {}
  @Subscription(() => Int, { topic: 'odd', filter: ({ payload }) => (payload as number) % 2 === 1 })
  odd() {}
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
    return ctx.state.mark === `filter ${ctx.parent}` ? ctx.parent : -1;
  }
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
  roles.clear();
  bumps = 0;
  filterSaw.length = 0;
});

async function start(
  options: GraphQLModuleOptions = {},
  providers: Provider[] = [],
  listen: ListenOptions = {},
): Promise<Started> {
  s = await startGraphQL([M], options, providers, listen);
  return s;
}

interface SseInit {
  method?: 'GET' | 'POST';
  accept?: string;
  headers?: Record<string, string>;
  /** GET only: leave out the CSRF header. */
  noCsrf?: boolean;
  signal?: AbortSignal;
}

/** Sends `query` to the GraphQL endpoint, asking for an event stream by default. */
function send(query: string, init: SseInit = {}): Promise<Response> {
  const url = new URL('/graphql', s!.app.url);
  const headers: Record<string, string> = {
    accept: init.accept ?? 'text/event-stream',
    ...init.headers,
  };
  if (init.method === 'GET') {
    url.searchParams.set('query', query);
    if (!init.noCsrf) headers['x-graphql-request'] = '1';
    return fetch(url, { headers, signal: init.signal });
  }
  headers['content-type'] = 'application/json';
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
    signal: init.signal,
  });
}

async function all(res: Response): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of readSse(res)) out.push(event);
  return out;
}

const next = (payload: unknown): SseEvent => ({ event: 'next', data: JSON.stringify(payload) });
const COMPLETE: SseEvent = { event: 'complete', data: '' };

const subscribers = (topic: string) => (s!.mod.get(PUBSUB) as PubSub).getSubscriberCount(topic);
const publish = (topic: string, payload: unknown) => s!.mod.get(PUBSUB).publish(topic, payload);

/** Opens an SSE subscription and waits until it listens to `topic`. */
async function open(query: string, topic: string, init: SseInit = {}) {
  const res = await send(query, init);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const events = readSse(res);
  await until(() => subscribers(topic) === 1);
  return events;
}

/** The `detail` of an application/problem+json error response. */
const detail = async (res: Response) => ((await res.json()) as { detail: string }).detail;

/** Reads `res` until it has carried `count` `:` comment blocks or `ms` passed; returns the count. */
async function commentsWithin(res: Response, count: number, ms: number): Promise<number> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const deadline = Date.now() + ms;
  let text = '';
  const seen = () => text.split(':\n\n').length - 1;
  try {
    while (seen() < count && Date.now() < deadline) {
      // Only the deadline can win the race, and the loop ends then: no read is left pending
      // while another starts, so no chunk is lost.
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
      ]);
      if (chunk === undefined || chunk.done) break;
      text += chunk.value;
    }
    return seen();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const logged = (level: string, text: string) =>
  s!.mod.logs.some((e) => e.level === level && e.message.includes(text));

const STILL_PENDING_SSE =
  'GraphQL SSE subscription: the context factory or onConnect is still pending after 100 ms; its connection slot stays held until it settles.';

async function expectJson(res: Response, status: number): Promise<any> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  return res.json();
}

describe('wantsEventStream', () => {
  test('text/event-stream wins only when it is strictly preferred over JSON', () => {
    expect(wantsEventStream('text/event-stream')).toBe(true);
    expect(wantsEventStream('text/event-stream;q=1, application/json;q=0.5')).toBe(true);
    expect(wantsEventStream(null)).toBe(false);
    expect(wantsEventStream('*/*')).toBe(false);
    expect(wantsEventStream('text/*')).toBe(false);
    expect(wantsEventStream('application/json, text/event-stream')).toBe(false);
    expect(wantsEventStream('text/event-stream, */*')).toBe(false);
    expect(wantsEventStream('text/event-stream, application/graphql-response+json')).toBe(false);
    expect(wantsEventStream('text/event-stream;q=0, application/json;q=0')).toBe(false);
  });
});

describe('GraphQL over SSE', () => {
  test('a subscription streams each event as next, then complete', async () => {
    await start();
    // A source that ends after two events, so the stream's completion is observable.
    const executor = s!.mod.get(GraphQLRuntime).executor;
    const real = executor.subscribe.bind(executor);
    executor.subscribe = (async (request: never, context: never) => {
      const result = await real(request, context);
      if (!(Symbol.asyncIterator in result)) return result;
      const it = result as SubscriptionIterator<unknown>;
      let left = 2;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (left-- <= 0) {
            await it.return?.();
            return { value: undefined, done: true };
          }
          return it.next();
        },
        return: () => it.return!(),
      };
    }) as typeof executor.subscribe;
    const events = await open('subscription { t }', 't');
    publish('t', 1);
    publish('t', 2);
    const received: SseEvent[] = [];
    for await (const event of events) received.push(event);
    expect(received).toEqual([next({ data: { t: 1 } }), next({ data: { t: 2 } }), COMPLETE]);
    expect(subscribers('t')).toBe(0);
  });

  test('a rejecting iterator return() is logged once and the stream still closes', async () => {
    await start();
    const executor = s!.mod.get(GraphQLRuntime).executor;
    const real = executor.subscribe.bind(executor);
    let returns = 0;
    executor.subscribe = (async (request: never, context: never) => {
      const result = await real(request, context);
      if (!(Symbol.asyncIterator in result)) return result;
      const it = result as SubscriptionIterator<unknown>;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => it.next(),
        async return() {
          returns++;
          await it.return?.();
          throw new Error('UNSUBSCRIBE failed');
        },
      };
    }) as typeof executor.subscribe;
    const events = await open('subscription { t }', 't');
    publish('t', 1);
    expect((await events.next()).value).toEqual(next({ data: { t: 1 } }));
    await events.return!();
    await until(() => returns > 0);
    await Bun.sleep(50);
    const entries = s!.mod.logs.filter((e) =>
      e.message.includes('Ending a GraphQL SSE subscription iterator failed'),
    );
    expect(entries).toHaveLength(1);
    expect(returns).toBe(1);
  });

  test('a subscription over GET streams too', async () => {
    await start();
    const events = await open('subscription { t }', 't', { method: 'GET' });
    publish('t', 7);
    expect((await events.next()).value).toEqual(next({ data: { t: 7 } }));
    await events.return!();
  });

  test('a query answers one next and complete', async () => {
    await start();
    for (const method of ['POST', 'GET'] as const) {
      const res = await send('{ n }', { method });
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(await all(res)).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    }
  });

  test('a POST mutation answers one next and complete', async () => {
    await start();
    expect(await all(await send('mutation { bump }'))).toEqual([
      next({ data: { bump: 1 } }),
      COMPLETE,
    ]);
  });

  test('a GET mutation is 405 with Allow: POST', async () => {
    await start();
    const res = await send('mutation { bump }', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(bumps).toBe(0);
  });

  test('Accept: */* and equal q-values stay JSON', async () => {
    await start();
    for (const accept of ['*/*', 'application/json, text/event-stream']) {
      const res = await send('{ n }', { accept });
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.json()).toEqual({ data: { n: 1 } });
    }
    const res = await send('{ n }', { accept: 'text/event-stream;q=1, application/json;q=0.5' });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await all(res)).toEqual([next({ data: { n: 1 } }), COMPLETE]);
  });

  test('a syntax error over SSE is 400 JSON', async () => {
    await start();
    for (const query of ['{ n', 'subscription { t', 'subscription { nope }']) {
      const body = await expectJson(await send(query), 400);
      expect(body.data).toBeUndefined();
      expect(body.errors).toHaveLength(1);
    }
    // The subscription request errors gave their slot back.
    expect(await upgradeStatus(s!.app)).toBe(101);
  });

  test('an internal error before execution is 500 JSON', async () => {
    const SECRET = 'redis://admin:pw@cache ECONNREFUSED';
    const brokenCache = {
      get: () => {
        throw new Error(SECRET);
      },
      set: () => {},
      getWithValidation: () => {
        throw new Error(SECRET);
      },
      setValidation: () => {},
      setWithValidation: () => {},
      has: () => false,
      delete: () => false,
      clear: () => {},
      getStats: () => ({ size: 0, maxSize: 0, hits: 0, misses: 0, hitRate: 0 }),
    } as never;
    await start({ cache: brokenCache });
    for (const query of ['{ n }', 'subscription { t }']) {
      const res = await send(query);
      const text = await res.clone().text();
      expect(text).not.toContain('admin:pw');
      const body = await expectJson(res, 500);
      expect(body.errors[0]).toMatchObject({
        message: 'Internal server error',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
  });

  test('subscriptions.sse: false keeps JSON for text/event-stream requests', async () => {
    await start({ subscriptions: { sse: false } });
    const res = await send('{ n }');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ data: { n: 1 } });
  });

  test('subscriptions: false keeps JSON too', async () => {
    await start({ subscriptions: false });
    const res = await send('{ n }');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  test('a cross-origin Origin is 403; allowedOrigins admits it; no Origin is allowed', async () => {
    await start();
    const port = s!.app.url.port;
    const cross = await send('{ n }', { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect(await detail(cross)).toBe('Cross-origin GraphQL SSE requests are not allowed.');
    const sub = await send('subscription { t }', { headers: { origin: 'https://evil.example' } });
    expect(sub.status).toBe(403);
    expect(subscribers('t')).toBe(0);
    const same = await send('{ n }', { headers: { origin: `http://127.0.0.1:${port}` } });
    expect(await all(same)).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    expect(await all(await send('{ n }'))).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    await s!.mod.close();
    await start({ subscriptions: { allowedOrigins: ['https://app.example'] } });
    const listed = await send('{ n }', { headers: { origin: 'https://app.example' } });
    expect(await all(listed)).toEqual([next({ data: { n: 1 } }), COMPLETE]);
  });

  test('a subscription on a schema without one is a 400 without onConnect', async () => {
    @Resolver()
    class QueryOnly {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [QueryOnly] })
    class Q {}
    let connects = 0;
    s = await startGraphQL([Q], {
      subscriptions: {
        onConnect: () => {
          connects++;
          return true;
        },
      },
    });
    // As over JSON: the operation type is refused on this transport before anything runs.
    const res = await send('subscription { t }');
    expect(res.status).toBe(400);
    const json = await send('subscription { t }', { accept: 'application/json' });
    expect(json.status).toBe(400);
    expect(await detail(res)).toBe(await detail(json));
    expect(connects).toBe(0);
    expect(await upgradeStatus(s.app)).not.toBe(101);
  });

  test('allowedOrigins is validated at bootstrap without a Subscription type', async () => {
    @Resolver()
    class QueryOnly {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [QueryOnly] })
    class Q {}
    const boot = (allowedOrigins: unknown) =>
      startGraphQL([Q], { subscriptions: { allowedOrigins: allowedOrigins as string[] } });
    await expect(boot('https://a.example')).rejects.toThrow(
      'allowedOrigins for GraphQL endpoint /graphql must be an array of origins or "*"; got ' +
        '"https://a.example".',
    );
    await expect(boot(['https://a.example/x'])).rejects.toThrow(
      'Invalid allowedOrigins entry for GraphQL endpoint /graphql: "https://a.example/x" ' +
        '(expected the bare origin "https://a.example").',
    );
    // Entries are normalized once (any case) and copied: changing the array later widens nothing.
    const origins = ['HTTPS://App.Example'];
    s = await startGraphQL([Q], { subscriptions: { allowedOrigins: origins } });
    origins.push('https://evil.example');
    const listed = await send('{ n }', { headers: { origin: 'https://app.example' } });
    expect(await all(listed)).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    expect((await send('{ n }', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  test('GET without the CSRF header is 400', async () => {
    await start();
    const res = await send('{ n }', { method: 'GET', noCsrf: true });
    expect(res.status).toBe(400);
    expect(await detail(res)).toBe(
      'GraphQL GET requests must include one of these headers: x-graphql-request.',
    );
  });

  test('onConnect false is 403 and nothing subscribes', async () => {
    let calls = 0;
    await start({
      subscriptions: {
        onConnect: () => {
          calls++;
          return false;
        },
      },
    });
    const body = await expectJson(await send('subscription { t }'), 403);
    expect(body).toEqual({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] });
    expect(calls).toBe(1);
    expect(subscribers('t')).toBe(0);
    // Queries do not run onConnect.
    expect(await all(await send('{ n }'))).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    expect(calls).toBe(1);
  });

  test('a throwing onConnect or context factory is 403 and is logged', async () => {
    await start({
      subscriptions: {
        onConnect: () => {
          throw new Error('onConnect secret');
        },
      },
    });
    const res = await send('subscription { t }');
    const text = await res.clone().text();
    expect(text).not.toContain('secret');
    await expectJson(res, 403);
    // The WebSocket wording, naming the transport.
    expect(
      logged('error', 'GraphQL subscriptions onConnect threw; rejecting the SSE connection'),
    ).toBe(true);
    await s!.mod.close();
    await start({
      context: () => {
        throw new Error('context secret');
      },
    });
    const denied = await send('subscription { t }');
    expect(await denied.clone().text()).not.toContain('secret');
    await expectJson(denied, 403);
    expect(subscribers('t')).toBe(0);
    expect(
      logged(
        'error',
        'GraphQL context factory threw at connection_init; rejecting the SSE connection',
      ),
    ).toBe(true);
  });

  test('onConnect receives {} and its object reaches the context', async () => {
    const seen: unknown[] = [];
    await start({
      context: () => ({ sseTenant: 'from-context' }),
      subscriptions: {
        onConnect: (http: Ctx, params) => {
          seen.push(params, http.req.headers.get('x-who'));
          return { sseTenant: 'from-connect' };
        },
      },
    });
    const events = await open('subscription { whoami }', 'tenant', { headers: { 'x-who': 'me' } });
    expect(seen).toEqual([{}, 'me']);
    publish('tenant', 1);
    expect((await events.next()).value).toEqual(next({ data: { whoami: 'from-connect' } }));
    await events.return!();
  });

  test('the endpoint guards and authorize guards run', async () => {
    await start({}, [
      { provide: APP_GUARD, multi: true, useValue: (ctx: Ctx) => ctx.req.headers.has('x-ok') },
    ]);
    expect((await send('subscription { t }')).status).toBe(403);
    expect(subscribers('t')).toBe(0);
    const res = await send('subscription { denied }', { headers: { 'x-ok': '1' } });
    expect(res.status).toBe(200);
    const events = await all(res);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.data).errors[0].extensions.code).toBe('FORBIDDEN');
    expect(events[1]).toEqual(COMPLETE);
    expect(subscribers('denied')).toBe(0);
    // The denied subscription released its slot.
    await s!.mod.close();
    await start({}, [], { websocket: { maxConnectionsPerIp: 1 } });
    expect((await all(await send('subscription { denied }'))).at(-1)).toEqual(COMPLETE);
    const again = await open('subscription { t }', 't');
    await again.return!();
  });

  test('recheckGuards with a revoked role ends the stream with FORBIDDEN', async () => {
    roles.set('u', 'admin');
    await start();
    const events = await open('subscription { byRole }', 'role');
    publish('role', 1);
    expect((await events.next()).value).toEqual(next({ data: { byRole: 1 } }));
    roles.set('u', 'user');
    publish('role', 2);
    const revoked = (await events.next()).value!;
    expect(JSON.parse(revoked.data).errors[0].extensions.code).toBe('FORBIDDEN');
    expect((await events.next()).value).toEqual(COMPLETE);
    expect((await events.next()).done).toBe(true);
    await until(() => subscribers('role') === 0);
  });

  test('filter and per-event fresh state behave as over WebSocket', async () => {
    await start();
    const odd = await open('subscription { odd }', 'odd');
    for (const n of [1, 2, 3]) publish('odd', n);
    expect((await odd.next()).value).toEqual(next({ data: { odd: 1 } }));
    expect((await odd.next()).value).toEqual(next({ data: { odd: 3 } }));
    await odd.return!();

    const filtered = await open('subscription { filtered }', 'filtered');
    publish('filtered', 1);
    expect((await filtered.next()).value).toEqual(next({ data: { filtered: 1 } }));
    publish('filtered', 2);
    expect((await filtered.next()).value).toEqual(next({ data: { filtered: 2 } }));
    expect(filterSaw).toEqual([undefined, undefined]);
    await filtered.return!();
  });

  test('a throwing iterator is masked under maskErrors', async () => {
    let fail: ((error: Error) => void) | undefined;
    let unsubscribed = 0;
    const engine = {
      subscribe: (_topic: string, _cb: unknown, onError?: (error: Error) => void) => {
        fail = onError;
        return () => {
          unsubscribed++;
        };
      },
      publish: () => {},
    };
    await start({ pubsub: engine as never });
    const res = await send('subscription { t }');
    expect(res.status).toBe(200);
    const events = readSse(res);
    await until(() => fail !== undefined);
    fail!(new Error('redis://admin:pw@cache down'));
    const errored = (await events.next()).value!;
    expect(errored.event).toBe('next');
    expect(errored.data).not.toContain('admin:pw');
    expect(JSON.parse(errored.data).errors[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect((await events.next()).value).toEqual(COMPLETE);
    expect((await events.next()).done).toBe(true);
    await until(() => unsubscribed === 1);
  });

  test('the stream counts against maxConnectionsPerIp', async () => {
    await start({}, [], { websocket: { maxConnectionsPerIp: 1 } });
    const first = await open('subscription { t }', 't');
    const limited = await send('subscription { t }');
    expect(limited.status).toBe(429);
    expect(await detail(limited)).toBe('Too many streaming connections from this address.');
    // Queries and mutations hold no slot.
    expect(await all(await send('{ n }'))).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    expect(await upgradeStatus(s!.app)).toBe(429);
    await first.return!();
    await until(async () => (await upgradeStatus(s!.app)) === 101);
  });

  test('the stream counts against maxConnections (503)', async () => {
    await start({}, [], { websocket: { maxConnections: 1 } });
    const first = await open('subscription { t }', 't');
    expect((await send('subscription { t }')).status).toBe(503);
    await first.return!();
  });

  test('a client abort returns the iterator and frees the slot', async () => {
    await start({}, [], { websocket: { maxConnectionsPerIp: 1 } });
    const abort = new AbortController();
    const res = await send('subscription { t }', { signal: abort.signal });
    expect(res.status).toBe(200);
    await until(() => subscribers('t') === 1);
    abort.abort();
    const aborted = Date.now();
    // Well under the 5000 ms keep-alive, which would otherwise be the first write to fail.
    await until(() => subscribers('t') === 0, 1000);
    expect(Date.now() - aborted).toBeLessThan(1000);
    const again = await open('subscription { t }', 't');
    publish('t', 1);
    expect((await again.next()).value).toEqual(next({ data: { t: 1 } }));
    await again.return!();
  });

  test('listen() rejects keepAliveInterval > idleTimeout / 2', async () => {
    const mod = await Test.createModule({
      imports: [
        GraphQLModule.forRoot({ subscriptions: { sse: { keepAliveInterval: 10_000 } } }),
        M,
      ],
    }).compile({ development: false });
    try {
      await expect(mod.createApp()).rejects.toThrow(
        'GraphQL SSE (subscriptions.sse.keepAliveInterval) keep-alive interval (10000 ms) must be ' +
          'at most half the HTTP idleTimeout (10 s, so at most 5000 ms)',
      );
      await expect(mod.createApp({ idleTimeout: 19 })).rejects.toThrow('at most half');
      await expect(mod.createApp({ idleTimeout: 20 })).resolves.toBeDefined();
    } finally {
      await mod.close();
    }
    await start({ subscriptions: { sse: { keepAliveInterval: 5_000 } } });
    await s!.mod.close();
    await start({ subscriptions: { sse: { keepAliveInterval: 10_000 } } }, [], { idleTimeout: 0 });
  });

  test('keep-alive comments are sent at keepAliveInterval', async () => {
    await start({ subscriptions: { sse: { keepAliveInterval: 20 } } });
    const res = await send('subscription { t }');
    // The opening comment, then at least two keep-alives.
    expect(await commentsWithin(res, 3, 2000)).toBe(3);
  });

  test('without keepAliveInterval, a stream keeps alive at half the idleTimeout', async () => {
    // idleTimeout 6, not 4: Bun checks idle connections on a 4 s tick, and a connection with an
    // idleTimeout of 4 s or less is closed at the next tick whatever it sends (measured on Bun
    // 1.4.3), so no keep-alive can hold it open.
    await start({}, [], { idleTimeout: 6 });
    const res = await send('subscription { t }');
    const opened = Date.now();
    // The opening comment, then a keep-alive after about 3000 ms (not Leaven's default 8000).
    expect(await commentsWithin(res, 2, 3800)).toBe(2);
    expect(Date.now() - opened).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - opened).toBeLessThan(3800);
  }, 10_000);

  test('a query-only app listens with a short idleTimeout', async () => {
    @Resolver()
    class QueryOnly {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [QueryOnly] })
    class Q {}
    s = await startGraphQL([Q], {}, [], { idleTimeout: 5 });
    expect(await all(await send('{ n }'))).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    // An app with subscriptions and no explicit keepAliveInterval listens too.
    await s.mod.close();
    await start({}, [], { idleTimeout: 1 });
  });

  test('an idleTimeout of 1 to 4 s logs one warning when SSE subscriptions are on', async () => {
    const warnings = () =>
      s!.mod.logs.filter((e) => e.level === 'warn' && e.message.includes('Bun may close quiet'));
    await start({}, [], { idleTimeout: 3 });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.message).toContain('GraphQL SSE subscriptions at /graphql');
    expect(warnings()[0]!.message).toContain('subscriptions.sse: false');
    expect(await all(await send('{ n }'))).toEqual([next({ data: { n: 1 } }), COMPLETE]);
    for (const listen of [{ idleTimeout: 0 }, { idleTimeout: 5 }, {}]) {
      await s!.mod.close();
      await start({}, [], listen);
      expect(warnings()).toHaveLength(0);
    }
    await s!.mod.close();
    await start({ subscriptions: { sse: false } }, [], { idleTimeout: 3 });
    expect(warnings()).toHaveLength(0);
    // No Subscription type: no long-lived stream, no warning.
    @Resolver()
    class QueryOnly {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [QueryOnly] })
    class Q {}
    await s!.mod.close();
    s = await startGraphQL([Q], {}, [], { idleTimeout: 3 });
    expect(warnings()).toHaveLength(0);
  });

  test('the slot is taken before onConnect: pending onConnect calls are bounded', async () => {
    let calls = 0;
    await start(
      {
        subscriptions: {
          onConnect: () => {
            calls++;
            return new Promise<boolean>(() => {});
          },
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const first = send('subscription { t }');
    await until(() => calls === 1);
    const second = await send('subscription { t }');
    expect(second.status).toBe(429);
    expect(calls).toBe(1);
    // close() does not wait for the pending onConnect.
    const started = Date.now();
    await s!.mod.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await first).status).toBe(503);
    s = undefined;
  });

  test('an aborted request keeps its slot until its onConnect settles', async () => {
    let calls = 0;
    let pending = 0;
    let most = 0;
    const settles: Array<(value: boolean) => void> = [];
    await start(
      {
        subscriptions: {
          onConnect: () => {
            calls++;
            pending++;
            most = Math.max(most, pending);
            return new Promise<boolean>((resolve) => {
              settles.push((value) => {
                pending--;
                resolve(value);
              });
            });
          },
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    // Open and abort 20 times: only the first reaches onConnect, the rest are refused with 429.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const abort = new AbortController();
      const res = send('subscription { t }', { signal: abort.signal }).then(
        (r) => r.status,
        () => 0,
      );
      if (i === 0) await until(() => calls === 1);
      else statuses.push(await res);
      abort.abort();
      await res;
    }
    expect(most).toBe(1);
    expect(calls).toBe(1);
    expect(statuses.every((status) => status === 429)).toBe(true);
    // Settling the pending onConnect returns the slot.
    settles[0]!(true);
    await until(() => pending === 0);
    const next = send('subscription { t }');
    await until(() => calls === 2);
    settles[1]!(false);
    expect((await next).status).toBe(403);
  });

  test('onConnect is skipped for a request aborted while the context factory runs', async () => {
    let connects = 0;
    let factories = 0;
    let settled = 0;
    let signal: AbortSignal | undefined;
    const gate = Promise.withResolvers<void>();
    await start(
      {
        context: async (ctx) => {
          factories++;
          signal = ctx.req.signal;
          await gate.promise;
          settled++;
          return {};
        },
        subscriptions: {
          onConnect: () => {
            connects++;
            return true;
          },
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const abort = new AbortController();
    const res = send('subscription { t }', { signal: abort.signal }).catch(() => undefined);
    await until(() => factories === 1);
    abort.abort();
    await res;
    // The server saw the abort before the factory settles.
    await until(() => signal?.aborted === true);
    gate.resolve();
    await until(() => settled === 1);
    // The slot comes back once the handshake settled: onConnect would have run by then.
    await until(async () => (await upgradeStatus(s!.app)) === 101);
    expect(connects).toBe(0);
  });

  test('a pending onConnect past connectionInitTimeout answers 503 and keeps its slot', async () => {
    let calls = 0;
    const settle = Promise.withResolvers<boolean>();
    await start(
      {
        subscriptions: {
          connectionInitTimeout: 100,
          onConnect: () => {
            calls++;
            return calls === 1 ? settle.promise : true;
          },
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const started = Date.now();
    const timedOut = await send('subscription { t }');
    expect(timedOut.status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    // The slot is held until onConnect settles, and the warning says so.
    expect((await send('subscription { t }')).status).toBe(429);
    await until(() => logged('warn', STILL_PENDING_SSE));
    expect(logged('debug', 'settled after')).toBe(false);
    settle.resolve(true);
    await until(() => logged('debug', 'GraphQL SSE subscription: the pending context factory'));
    await until(async () => (await upgradeStatus(s!.app)) === 101);
    const events = await open('subscription { t }', 't');
    await events.return!();
  });

  test('a context factory that throws on its second call gives the slot back', async () => {
    // The first call (the handshake) passes; the second (the subscription's operation context)
    // throws, after the slot was taken.
    let calls = 0;
    await start(
      {
        context: () => {
          calls++;
          if (calls === 2) throw new Error('postgres://admin:pw@db down');
          return {};
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const failed = await send('subscription { t }');
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(body).not.toContain('admin:pw');
    expect(body).not.toContain('db down');
    expect(calls).toBe(2);
    expect(subscribers('t')).toBe(0);
    // The slot is free again: the next subscription streams.
    const events = await open('subscription { t }', 't');
    publish('t', 1);
    expect((await events.next()).value).toEqual(next({ data: { t: 1 } }));
    await events.return!();
  });

  test('onConnect false gives the slot back', async () => {
    let allow = false;
    await start({ subscriptions: { onConnect: () => allow } }, [], {
      websocket: { maxConnectionsPerIp: 1 },
    });
    expect((await send('subscription { t }')).status).toBe(403);
    expect((await send('subscription { t }')).status).toBe(403);
    allow = true;
    const events = await open('subscription { t }', 't');
    await events.return!();
  });

  test('request-error JSON carries cacheControl', async () => {
    await start({ cacheControl: 'no-store' });
    const res = await send('{ n');
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('close() with an open SSE stream resolves quickly', async () => {
    await start();
    const events = await open('subscription { t }', 't');
    const started = Date.now();
    await s!.mod.close();
    expect(Date.now() - started).toBeLessThan(1000);
    // The stream ended without complete.
    expect((await events.next()).done).toBe(true);
    s = undefined;
  });
});

/** Leaven's document cache with every read counted (`get` is what executor.parse() reads). */
function countingCache() {
  const inner = new DocumentCache({ maxSize: 100 });
  const reads = { get: 0, getWithValidation: 0 };
  const order: string[] = [];
  const cache = {
    get: (key: string) => {
      reads.get++;
      order.push('cache.get');
      return inner.get(key);
    },
    getWithValidation: (key: string) => {
      reads.getWithValidation++;
      order.push('cache.getWithValidation');
      return inner.getWithValidation(key);
    },
    set: inner.set.bind(inner),
    setValidation: inner.setValidation.bind(inner),
    setWithValidation: inner.setWithValidation.bind(inner),
    has: inner.has.bind(inner),
    delete: inner.delete.bind(inner),
    clear: inner.clear.bind(inner),
    getStats: inner.getStats.bind(inner),
  };
  return { cache: cache as never, reads, order };
}

describe('SSE responses, origin and dispatch', () => {
  test('streams carry the configured Cache-Control and nosniff: a query and a subscription', async () => {
    await start();
    const query = await send('{ n }');
    expect(query.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(query.headers.get('cache-control')).toBe('no-store');
    expect(query.headers.get('x-content-type-options')).toBe('nosniff');
    await query.text();
    const res = await send('subscription { t }');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await res.body!.cancel();
    await s!.mod.close();
    await start({ cacheControl: 'private, max-age=0' });
    const custom = await send('{ n }');
    expect(custom.headers.get('cache-control')).toBe('private, max-age=0');
    await custom.text();
  });

  test('a cross-origin request is refused before its body or CSRF header is read', async () => {
    await start();
    const url = new URL('/graphql', s!.app.url);
    const evil = { accept: 'text/event-stream', origin: 'https://evil.example' };
    // Malformed JSON and a wrong content type would be 400 and 415 if the body were read first.
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { ...evil, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(403);
    const plain = await fetch(url, {
      method: 'POST',
      headers: { ...evil, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(plain.status).toBe(403);
    url.searchParams.set('query', '{ n }');
    expect((await fetch(url, { headers: evil })).status).toBe(403);
  });

  test("the document is parsed once, after the app's onParse: no extra cache read", async () => {
    const { cache, reads, order } = countingCache();
    let parses = 0;
    let connects = 0;
    await start({
      cache,
      hooks: {
        onParse: () => {
          parses++;
          order.push('onParse');
        },
      },
      subscriptions: {
        onConnect: () => {
          connects++;
          return true;
        },
      },
    });
    // An invalid document: the app's hook runs first, Leaven parses it once.
    expect((await send('{ n')).status).toBe(400);
    expect(order).toEqual(['onParse', 'cache.getWithValidation']);
    expect(reads.get).toBe(0);
    // A query: one pass, hooks once.
    order.length = 0;
    parses = 0;
    await all(await send('{ n }'));
    expect(parses).toBe(1);
    expect(reads.get).toBe(0);
    // A subscription: hooks once, and the second (subscribe) pipeline hits the cache.
    parses = 0;
    order.length = 0;
    const events = await open('subscription { t }', 't');
    expect(parses).toBe(1);
    expect(connects).toBe(1);
    expect(reads.get).toBe(0);
    expect(order).toEqual(['onParse', 'cache.getWithValidation', 'cache.getWithValidation']);
    await events.return!();
  });

  test('an invalid subscription document is a 400 without a slot or onConnect', async () => {
    let connects = 0;
    await start(
      {
        subscriptions: {
          onConnect: () => {
            connects++;
            return true;
          },
        },
      },
      [],
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const res = await send('subscription { nope }');
    const body = await expectJson(res, 400);
    expect(body.errors[0].extensions.code).toBe('VALIDATION_ERROR');
    expect(connects).toBe(0);
    // Knead's document limits run before any slot too.
    const aliases = Array.from({ length: 31 }, (_, i) => `a${i}: t`).join(' ');
    expect((await send(`subscription { ${aliases} }`)).status).toBe(400);
    expect(connects).toBe(0);
    const events = await open('subscription { t }', 't');
    await events.return!();
  });

  test('a document cache that throws once is a logged 500; the next request works', async () => {
    const { cache } = countingCache();
    // Whichever read comes first fails, once (an executor.parse() pre-check would read `get`).
    const reads = cache as Record<'get' | 'getWithValidation', (key: string) => unknown>;
    let fail = true;
    for (const name of ['get', 'getWithValidation'] as const) {
      const original = reads[name];
      reads[name] = (key) => {
        if (fail) {
          fail = false;
          throw new Error('cache read failed');
        }
        return original(key);
      };
    }
    await start({ cache });
    const res = await send('subscription { t }');
    const body = await expectJson(res, 500);
    expect(body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(logged('error', 'GraphQL execution failed inside Leaven')).toBe(true);
    const events = await open('subscription { t }', 't');
    await events.return!();
  });

  test('a subscription without a Subscription type over GET is a 405, as over JSON', async () => {
    @Resolver()
    class Only {
      @Query(() => Int) one() {
        return 1;
      }
    }
    @Module({ providers: [Only] })
    class OnlyModule {}
    s = await startGraphQL([OnlyModule]);
    const res = await send('subscription { one }', { method: 'GET' });
    // One rule for both paths (throwRejected): a subscription over POST is 400, over GET 405.
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const json = await fetch(new URL('/graphql?query=subscription%7Bone%7D', s.app.url), {
      headers: { 'x-graphql-request': '1' },
    });
    expect(res.status).toBe(json.status);
  });

  test('without a Subscription type, the rejection names neither SSE nor a header the request sent', async () => {
    @Resolver()
    class Only {
      @Query(() => Int) one() {
        return 1;
      }
    }
    @Module({ providers: [Only] })
    class OnlyModule {}
    s = await startGraphQL([OnlyModule]);
    const message = 'Subscriptions are only available over WebSocket.';
    const get = await send('subscription { one }', { method: 'GET' });
    expect(get.status).toBe(405);
    expect(await detail(get)).toBe(message);
    const post = await send('subscription { one }');
    expect(post.status).toBe(400);
    expect(await detail(post)).toBe(message);
    const json = await send('subscription { one }', { accept: 'application/json' });
    expect(json.status).toBe(400);
    expect(await detail(json)).toBe(message);
  });

  test('a JSON subscription request on a schema with subscriptions is pointed at SSE', async () => {
    await start();
    const res = await send('subscription { t }', { accept: 'application/json' });
    expect(res.status).toBe(400);
    expect(await detail(res)).toBe(
      'Subscriptions are only available over WebSocket or with Accept: text/event-stream.',
    );
  });
});

describe('SSE internals stay private', () => {
  test('the runtime exposes no SSE connection registry; the package exports no accessor', async () => {
    await start();
    const runtime = s!.mod.get(GraphQLRuntime) as unknown as Record<string, unknown>;
    expect('sse' in runtime).toBe(false);
    expect('sseConnections' in runtime).toBe(false);
    const index = await import('../src/index.js');
    for (const name of ['sseConnectionsOf', 'subscribeAgain', 'SseConnections', 'handleSse']) {
      expect(name in index).toBe(false);
    }
  });
});
