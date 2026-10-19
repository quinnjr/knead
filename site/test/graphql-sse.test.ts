// Pins the claims of the guide's "Subscriptions over SSE" section and the snippets it includes.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { LOGGER, Module, type Provider } from '@knead-js/core';
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLSubscriptions,
  PUBSUB,
  Query,
  Resolver,
} from '@knead-js/graphql';
import { HttpConfigError, type ListenOptions, WS_DEFAULTS } from '@knead-js/http';
import { readSse, Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../snippets/graphql/app.module.js';
import { BlogModule } from '../snippets/graphql/blog.module.js';
import { SignOutService } from '../snippets/graphql/revocation.js';
import { type Member, SessionModule } from '../snippets/graphql/sessions.js';
import { subscribe, WebSocketOnlyModule } from '../snippets/graphql/sse.js';

// The keep-alive interval each stream uses, read where @knead-js/graphql hands it to Leaven's
// createEventStreamResponse (the module is wrapped in place; the wrapper only records it).
const ssePath = Bun.resolveSync(
  '@leaven-graphql/sse',
  dirname(Bun.resolveSync('@knead-js/graphql', import.meta.dir)),
);
const leavenSse = { ...(await import(ssePath)) };
const createEventStreamResponse = leavenSse.createEventStreamResponse;
const keepAlives: unknown[] = [];
mock.module(ssePath, () => ({
  ...leavenSse,
  createEventStreamResponse: (result: unknown, options?: { keepAliveInterval?: number }) => {
    keepAlives.push(options?.keepAliveInterval);
    return createEventStreamResponse(result, options);
  },
}));
beforeEach(() => {
  keepAlives.length = 0;
});
// mock.module is process-wide: later test files must see the original module again.
afterAll(() => {
  mock.module(ssePath, () => leavenSse);
});

let mod: TestingModule | undefined;

afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function boot(
  imports: Parameters<typeof Test.createModule>[0]['imports'],
  { providers = [], listen }: { providers?: Provider[]; listen?: ListenOptions } = {},
): Promise<TestApp> {
  mod = await Test.createModule({ imports, providers }).compile({ development: false });
  return mod.createApp(listen);
}

/** The guide's blog types and resolvers under `GraphQLModule.forRoot(options)`. */
function blog(options: GraphQLModuleOptions, listen?: ListenOptions): Promise<TestApp> {
  return boot([GraphQLModule.forRoot({ emitSchemaFile: false, ...options }), BlogModule], {
    listen,
  });
}

const ada = { authorization: 'Bearer ada-token' };
const sse = { accept: 'text/event-stream', 'content-type': 'application/json' };
const MESSAGE = 'subscription { message(room: "r1") }';

/**
 * Publishes chat messages until `next` settles (for the fetch client the request is still being
 * sent when next() is called), for at most 10 s.
 */
async function firstEvent<T>(next: () => Promise<T>): Promise<T> {
  const pending = next();
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 10_000;
  while (!settled && Date.now() < deadline) {
    mod!.get(PUBSUB).publish('chat.r1', { text: 'hello' });
    await Bun.sleep(20);
  }
  return pending;
}

/** An onConnect that waits for `release()`, and a promise of its first call. */
function gatedOnConnect() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const grace: Member = { id: 'a2', name: 'Grace Hopper', roles: [] };
  const onConnect = async () => {
    entered();
    await gate;
    return { member: grace };
  };
  return { onConnect, release, called };
}

/** Reads a query over SSE to its end and returns the keep-alive interval its stream used. */
async function keepAliveOf(app: TestApp): Promise<unknown> {
  const res = await app.request('POST', '/graphql', {
    headers: sse,
    json: { query: '{ __typename }' },
  });
  await res.text();
  return keepAlives.at(-1);
}

describe('guide: subscriptions over SSE', () => {
  test('SSE is on by default: a subscription streams, authenticated by its Authorization header', async () => {
    const app = await boot([AppModule]);
    const sub = await app.subscribeSse(MESSAGE, { headers: ada });
    const { value } = await firstEvent(() => sub.next());
    expect(value).toEqual({ data: { message: 'hello' } });
    await sub.close();
  });

  test("the guide's onConnect refuses an SSE subscription without a token with 403 JSON", async () => {
    const app = await boot([AppModule]);
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: MESSAGE },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({
      errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
    });
  });

  test('onConnect receives the request Ctx and {} as its params', async () => {
    const seen: unknown[] = [];
    const app = await blog({
      subscriptions: {
        onConnect: (http, params) => {
          seen.push(params, http.req.headers.get('authorization'));
          return true;
        },
      },
    });
    const sub = await app.subscribeSse(MESSAGE, { headers: ada });
    expect(seen).toEqual([{}, 'Bearer ada-token']);
    await sub.close();
  });

  test('a query answers one next event, then complete', async () => {
    const app = await boot([AppModule]);
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: '{ __typename }' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = [];
    for await (const event of readSse(res)) events.push(event);
    expect(events).toEqual([
      { event: 'next', data: '{"data":{"__typename":"Query"}}' },
      { event: 'complete', data: '' },
    ]);
  });

  test('Accept must prefer text/event-stream strictly: */* and ties stay JSON', async () => {
    const app = await boot([AppModule]);
    for (const accept of ['*/*', 'text/event-stream, application/json']) {
      const res = await app.request('POST', '/graphql', {
        headers: { accept },
        json: { query: '{ __typename }' },
      });
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    }
    const res = await app.request('POST', '/graphql', {
      headers: { accept: 'text/event-stream, application/json;q=0.9' },
      json: { query: '{ __typename }' },
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    await res.body?.cancel();
  });

  test('a mutation over GET is 405 with Allow: POST', async () => {
    const app = await boot([AppModule]);
    const res = await app.request('GET', '/graphql', {
      headers: { accept: 'text/event-stream', 'x-graphql-request': '1' },
      query: { query: 'mutation { createPost(input: { title: "Hello" }) { id } }' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  test('a cross-origin request is 403; allowedOrigins admits it; no Origin is allowed', async () => {
    const query = { query: '{ __typename }' };
    let app = await boot([AppModule]);
    const evil = await app.request('POST', '/graphql', {
      headers: { ...sse, origin: 'https://evil.example' },
      json: query,
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('content-type')).toStartWith('application/problem+json');
    const none = await app.request('POST', '/graphql', { headers: sse, json: query });
    expect(none.status).toBe(200);
    await none.text();
    await mod!.close();

    app = await blog({ subscriptions: { allowedOrigins: ['https://app.example'] } });
    const allowed = await app.request('POST', '/graphql', {
      headers: { ...sse, origin: 'https://app.example' },
      json: query,
    });
    expect(allowed.status).toBe(200);
    await allowed.text();
  });

  test('a document cache that throws is a request error: 500 JSON', async () => {
    const down = () => {
      throw new Error('cache down');
    };
    const app = await blog({
      cache: {
        get: down,
        set: () => {},
        getWithValidation: down,
        setValidation: () => {},
        setWithValidation: () => {},
        has: () => false,
        delete: () => false,
        clear: () => {},
        getStats: () => ({ size: 0, maxSize: 0, hits: 0, misses: 0, hitRate: 0 }),
      } as never,
    });
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: '{ __typename }' },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as { errors: { extensions: { code: string } }[] };
    expect(body.errors[0]?.extensions.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('a request error is JSON with 400 and Cache-Control, never a stream', async () => {
    const app = await boot([AppModule]);
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: '{' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { errors: { extensions: { code: string } }[] };
    expect(body.errors[0]?.extensions.code).toBe('PARSE_ERROR');
  });

  test('an error once execution started is streamed as a next event', async () => {
    const app = await boot([AppModule]);
    // createPost needs a signed-in member: its resolver runs and throws UNAUTHENTICATED.
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: 'mutation { createPost(input: { title: "Hello" }) { id } }' },
    });
    expect(res.status).toBe(200);
    const [next, complete] = await Array.fromAsync(readSse(res));
    expect(next?.event).toBe('next');
    expect(JSON.parse(next!.data).errors[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(complete?.event).toBe('complete');
  });

  test('a GET needs the CSRF header; with csrf: false a bare EventSource-style GET streams', async () => {
    const query = { query: '{ __typename }' };
    let app = await boot([AppModule]);
    const bare = await app.request('GET', '/graphql', {
      headers: { accept: 'text/event-stream' },
      query,
    });
    expect(bare.status).toBe(400);
    const withHeader = await app.request('GET', '/graphql', {
      headers: { accept: 'text/event-stream', 'x-graphql-request': '1' },
      query,
    });
    expect(withHeader.status).toBe(200);
    await withHeader.body?.cancel();
    await mod!.close();

    app = await blog({ csrf: false });
    const open = await app.request('GET', '/graphql', {
      headers: { accept: 'text/event-stream' },
      query,
    });
    expect(open.status).toBe(200);
    expect(open.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    await open.body?.cancel();
  });

  test('subscriptions.sse: false answers text/event-stream requests with JSON', async () => {
    const app = await boot([WebSocketOnlyModule]);
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: '{ __typename }' },
    });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ data: { __typename: 'Query' } });
  });

  test('a stream takes a WebSocket connection slot: past maxConnectionsPerIp, 429', async () => {
    const app = await blog({}, { websocket: { maxConnectionsPerIp: 1 } });
    const sub = await app.subscribeSse(MESSAGE);
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toStartWith('application/problem+json');
    await sub.close();
  });

  test('past maxConnections (shared with WebSocket), 503', async () => {
    const app = await blog({}, { websocket: { maxConnections: 1 } });
    const sub = await app.subscribeSse(MESSAGE);
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toStartWith('application/problem+json');
    await sub.close();
  });

  test('the shared limits default to 100 per IP and 10000 kept revocations', () => {
    expect(WS_DEFAULTS.maxConnectionsPerIp).toBe(100);
    expect(WS_DEFAULTS.maxPendingRevocations).toBe(10000);
  });

  test('a revocation kept while onConnect is pending answers 403 when it settles', async () => {
    const gated = gatedOnConnect();
    const app = await blog({ subscriptions: { onConnect: gated.onConnect } });
    const pending = app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    await gated.called;
    const subscriptions = mod!.get(GraphQLSubscriptions);
    expect(subscriptions.closeWhere(({ context }) => (context.member as Member)?.id === 'a2')).toBe(
      0,
    );
    gated.release();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
    });
  });

  test('a stream ended before onConnect settles answers 503: a match on http, or shutdown', async () => {
    let gated = gatedOnConnect();
    const app = await blog({ subscriptions: { onConnect: () => gated.onConnect() } });
    let pending = app.request('POST', '/graphql', {
      headers: { ...sse, 'x-session': 's1' },
      json: { query: MESSAGE },
    });
    await gated.called;
    const subscriptions = mod!.get(GraphQLSubscriptions);
    expect(subscriptions.closeWhere(({ http }) => http.req.headers.get('x-session') === 's1')).toBe(
      1,
    );
    expect((await pending).status).toBe(503);
    gated.release();

    gated = gatedOnConnect();
    pending = app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    await gated.called;
    const closing = mod!.close();
    mod = undefined;
    expect((await pending).status).toBe(503);
    gated.release();
    await closing;
  });

  test('an aborted request keeps its slot until onConnect settles; onConnect is bounded', async () => {
    const gated = gatedOnConnect();
    const app = await blog(
      { subscriptions: { onConnect: () => gated.onConnect() } },
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const abort = new AbortController();
    const url = new URL('/graphql', app.url);
    const aborted = fetch(url, {
      method: 'POST',
      headers: sse,
      body: JSON.stringify({ query: MESSAGE }),
      signal: abort.signal,
    }).catch(() => undefined);
    await gated.called;
    abort.abort();
    await aborted;
    // The client left, but its onConnect is still pending: the slot is still taken.
    const refused = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: MESSAGE },
    });
    expect(refused.status).toBe(429);
    gated.release();
    // Once it settles the slot is free again (retried briefly: it is returned asynchronously).
    const deadline = Date.now() + 2000;
    for (;;) {
      const sub = await app.subscribeSse(MESSAGE).catch((error: unknown) => {
        if (Date.now() > deadline) throw error;
        return undefined;
      });
      if (sub) {
        await sub.close();
        break;
      }
      await Bun.sleep(10);
    }
  });

  test('a pending onConnect answers 503 after connectionInitTimeout, default 3000 ms', async () => {
    const gated = gatedOnConnect();
    const app = await blog({ subscriptions: { onConnect: () => gated.onConnect() } });
    const started = Date.now();
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - started).toBeLessThan(4500);
    gated.release();
  }, 10_000);

  test('over WebSocket, a pending onConnect is closed with 4408 after connectionInitTimeout', async () => {
    const gated = gatedOnConnect();
    const app = await blog({
      subscriptions: { connectionInitTimeout: 100, onConnect: () => gated.onConnect() },
    });
    const url = new URL('/graphql', app.url);
    url.protocol = 'ws:';
    const ws = new WebSocket(url, 'graphql-transport-ws');
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (event) => resolve(event.code);
    });
    ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    await gated.called;
    expect(await closed).toBe(4408);
    gated.release();
  });

  test('a subscription without a Subscription type is a 400, as over JSON, without onConnect', async () => {
    @Resolver()
    class Hello {
      @Query(() => String) hello() {
        return 'hi';
      }
    }
    @Module({ providers: [Hello] })
    class HelloModule {}
    let connects = 0;
    const app = await boot([
      GraphQLModule.forRoot({
        emitSchemaFile: false,
        subscriptions: {
          onConnect: () => {
            connects++;
            return true;
          },
        },
      }),
      HelloModule,
    ]);
    const res = await app.request('POST', '/graphql', {
      headers: sse,
      json: { query: 'subscription { hello }' },
    });
    expect(res.status).toBe(400);
    expect(connects).toBe(0);
  });

  test('allowedOrigins entries are validated at bootstrap, with or without subscriptions', () => {
    for (const allowedOrigins of [['https://app.example/path'], 'https://app.example']) {
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { allowedOrigins: allowedOrigins as string[] } }),
      ).toThrow(HttpConfigError);
    }
    GraphQLModule.forRoot({ subscriptions: { allowedOrigins: ['https://App.Example'] } });
  });

  test('subscribeSse rejects a 200 that is not an event stream (SSE turned off)', async () => {
    const app = await blog({ subscriptions: { sse: false } });
    await expect(app.subscribeSse('{ __typename }')).rejects.toThrow(
      'GraphQL SSE response is not an event stream (status 200, content-type application/json',
    );
  });

  test('closeWhere ends a matching stream without complete', async () => {
    const app = await boot([AppModule, SessionModule], { providers: [SignOutService] });
    const sub = await app.subscribeSse(MESSAGE, {
      headers: { authorization: 'Bearer grace-token' },
    });
    expect(mod!.get(SignOutService).signOut('grace-token', 'a2')).toBe(1);
    await expect(sub.next()).rejects.toThrow('SSE stream ended without a complete event');
  });

  test('maxConnectionLifetime ends a stream without complete', async () => {
    const app = await blog({ subscriptions: { maxConnectionLifetime: 100 } });
    const sub = await app.subscribeSse(MESSAGE);
    await expect(sub.next()).rejects.toThrow('SSE stream ended without a complete event');
  });

  test('an explicit keepAliveInterval above half the idleTimeout fails listen()', async () => {
    for (const keepAliveInterval of [5001, 6000]) {
      const error = await blog(
        { subscriptions: { sse: { keepAliveInterval } } },
        { idleTimeout: 10 },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpConfigError);
      expect((error as Error).message).toContain('must be at most half the HTTP idleTimeout');
      await mod?.close();
    }
    // Exactly half is allowed, and the stream uses it.
    const app = await blog({ subscriptions: { sse: { keepAliveInterval: 5000 } } }, {});
    expect(await keepAliveOf(app)).toBe(5000);
  });

  test('keepAliveInterval is an integer from 1 to 2147483647', () => {
    for (const keepAliveInterval of [0, 1.5, 2 ** 31]) {
      expect(() =>
        GraphQLModule.forRoot({ subscriptions: { sse: { keepAliveInterval } } }),
      ).toThrow(HttpConfigError);
    }
    for (const keepAliveInterval of [1, 2147483647]) {
      GraphQLModule.forRoot({ subscriptions: { sse: { keepAliveInterval } } });
    }
  });

  test("without keepAliveInterval: half the idleTimeout, 5000 ms at Bun's default, at most 8000", async () => {
    for (const [listen, expected] of [
      [{}, 5000], // Bun's default idleTimeout, 10 s
      [{ idleTimeout: 6 }, 3000],
      [{ idleTimeout: 30 }, 8000],
      [{ idleTimeout: 0 }, 8000],
    ] as const) {
      const app = await blog({}, listen);
      expect(await keepAliveOf(app)).toBe(expected);
      await mod!.close();
      mod = undefined;
    }
  });

  test('a stream sends a comment at once, then keep-alives before the idle timeout', async () => {
    const app = await blog({}, { idleTimeout: 6 });
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(':\n\n'); // sent at once
    const started = Date.now();
    expect((await reader.read()).value).toBe(':\n\n'); // the first keep-alive (3000 ms)
    // Not a stream of comments, and in time to keep the 6 s idle timeout from closing it.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(6000);
    await reader.cancel();
  }, 15_000);

  test('an idleTimeout of 1 to 4 s logs one warning at listen(); 5 and 0 do not', async () => {
    for (const [idleTimeout, warnings] of [
      [1, 1],
      [4, 1],
      [5, 0],
      [0, 0],
    ] as const) {
      mod = await Test.createModule({
        imports: [GraphQLModule.forRoot({ emitSchemaFile: false }), BlogModule],
      }).compile({ development: false });
      const warn = spyOn(mod.get(LOGGER), 'warn');
      await mod.createApp({ idleTimeout });
      const streams = warn.mock.calls.filter(([m]) =>
        String(m).includes('may close quiet streams early'),
      );
      expect([idleTimeout, streams.length]).toEqual([idleTimeout, warnings]);
      await mod.close();
      mod = undefined;
    }
  });
});

describe('guide: the fetch client', () => {
  test('yields each result, with the token as a bearer header', async () => {
    const app = await boot([AppModule]);
    const results = subscribe(new URL('/graphql', app.url).href, MESSAGE, { token: 'ada-token' });
    const { value } = await firstEvent(() => results.next());
    expect(value).toEqual({ data: { message: 'hello' } });
    await results.return(undefined);
  });

  test('a refused request rejects with its status', async () => {
    const app = await boot([AppModule]);
    const results = subscribe(new URL('/graphql', app.url).href, MESSAGE);
    await expect(results.next()).rejects.toThrow('403');
  });

  test('a query ends after its one result', async () => {
    const app = await boot([AppModule]);
    const all = await Array.fromAsync(
      subscribe(new URL('/graphql', app.url).href, '{ __typename }'),
    );
    expect(all).toEqual([{ data: { __typename: 'Query' } }]);
  });
});
