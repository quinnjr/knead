// Pins the claims of the guide's "Subscriptions over SSE" section and the snippets it includes.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { LOGGER, type Provider } from '@knead-js/core';
import { GraphQLModule, type GraphQLModuleOptions, PUBSUB } from '@knead-js/graphql';
import { HttpConfigError, type ListenOptions } from '@knead-js/http';
import { readSse, Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../snippets/graphql/app.module.js';
import { BlogModule } from '../snippets/graphql/blog.module.js';
import { SignOutService } from '../snippets/graphql/revocation.js';
import { SessionModule } from '../snippets/graphql/sessions.js';
import { subscribe, WebSocketOnlyModule } from '../snippets/graphql/sse.js';

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

/** The blog with `options` (and a context reading the bearer token). */
function blog(options: GraphQLModuleOptions, listen?: ListenOptions): Promise<TestApp> {
  return boot([GraphQLModule.forRoot({ emitSchemaFile: false, ...options }), BlogModule], {
    listen,
  });
}

const ada = { authorization: 'Bearer ada-token' };
const sse = { accept: 'text/event-stream', 'content-type': 'application/json' };
const MESSAGE = 'subscription { message(room: "r1") }';

/** Publishes chat messages until `next` yields one (the subscription registers just before). */
async function firstEvent<T>(next: () => Promise<T>): Promise<T> {
  const pending = next();
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 50 && !settled; i++) {
    mod!.get(PUBSUB).publish('chat.r1', { text: 'hello' });
    await Bun.sleep(10);
  }
  return pending;
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
    const error = await blog(
      { subscriptions: { sse: { keepAliveInterval: 6000 } } },
      { idleTimeout: 10 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpConfigError);
    expect((error as Error).message).toContain('must be at most half the HTTP idleTimeout');
  });

  test('without keepAliveInterval a stream keeps alive at half the idleTimeout', async () => {
    const app = await blog({}, { idleTimeout: 6 });
    const res = await app.request('POST', '/graphql', { headers: sse, json: { query: MESSAGE } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe(':\n\n'); // sent at once
    const started = Date.now();
    expect((await reader.read()).value).toBe(':\n\n'); // the first keep-alive, 3000 ms later
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    await reader.cancel();
  }, 10_000);

  test('an idleTimeout of 1 to 4 s logs one warning at listen()', async () => {
    mod = await Test.createModule({
      imports: [GraphQLModule.forRoot({ emitSchemaFile: false }), BlogModule],
    }).compile({ development: false });
    const warn = spyOn(mod.get(LOGGER), 'warn');
    await mod.createApp({ idleTimeout: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('may close quiet streams early');
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
