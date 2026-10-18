import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { APP_GUARD, type Ctx, originAllowed } from '@knead-js/http';
import { RateLimitModule } from '@knead-js/rate-limit';
import { Int, Mutation, PUBSUB, type PubSub, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL, until, upgradeStatus } from './helpers.js';

let bumps = 0;

@Resolver()
class R {
  @Query(() => Int) n() {
    return bumps;
  }
  @Mutation(() => Int) bump() {
    return ++bumps;
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

describe('WebSocket transport security', () => {
  test('queries and mutations are refused over WebSocket and never execute', async () => {
    s = await startGraphQL([M]);
    bumps = 0;
    for (const query of ['mutation { bump }', '{ n }']) {
      const sub = await s.app.graphqlSubscribe(query);
      const first = await sub.next();
      expect(first.value?.errors?.[0]).toMatchObject({
        message: 'Only subscription operations are allowed over WebSocket.',
        extensions: { code: 'BAD_USER_INPUT' },
      });
      expect((await sub.next()).done).toBe(true);
      await sub.close();
    }
    expect(bumps).toBe(0);
  });

  test('APP_GUARD guards run on the upgrade', async () => {
    s = await startGraphQL([M], {}, [
      { provide: APP_GUARD, multi: true, useValue: (ctx: Ctx) => ctx.req.headers.has('x-ok') },
    ]);
    expect(await upgradeStatus(s.app)).toBe(403);
    expect(await upgradeStatus(s.app, { 'x-ok': '1' })).toBe(101);
  });

  test('a header-authenticating APP_GUARD can let upgrades through via ctx.upgrade', async () => {
    const bearer = (ctx: Ctx) =>
      ctx.upgrade !== null || ctx.req.headers.get('authorization') === 'Bearer ok';
    s = await startGraphQL([M], {}, [{ provide: APP_GUARD, multi: true, useValue: bearer }]);
    expect(await upgradeStatus(s.app)).toBe(101);
    expect((await s.app.graphql('{ n }')).status).toBe(403);
    const ok = await s.app.graphql('{ n }', { headers: { authorization: 'Bearer ok' } });
    expect(ok.status).toBe(200);
  });

  test('cross-origin upgrades are 403 by default; no Origin header is allowed', async () => {
    s = await startGraphQL([M]);
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(s.app, { origin: `http://127.0.0.1:${s.app.url.port}` })).toBe(101);
    expect(await upgradeStatus(s.app)).toBe(101);
  });

  test('same-origin also requires the same scheme', async () => {
    s = await startGraphQL([M]);
    // The test server speaks plain HTTP, so an https:// page on the same host is another origin.
    expect(await upgradeStatus(s.app, { origin: `https://127.0.0.1:${s.app.url.port}` })).toBe(403);
  });

  test('originAllowed compares scheme and host', () => {
    expect(originAllowed('https://app.example', 'app.example', true, undefined)).toBe(true);
    expect(originAllowed('http://app.example', 'app.example', true, undefined)).toBe(false);
    expect(originAllowed('http://app.example', 'APP.example', false, undefined)).toBe(true);
    expect(originAllowed('https://app.example', 'app.example', false, undefined)).toBe(false);
    expect(originAllowed('null', 'app.example', false, undefined)).toBe(false);
    expect(originAllowed(null, 'app.example', true, undefined)).toBe(true);
  });

  test('default ports are normalized on both sides of the same-origin check', async () => {
    s = await startGraphQL([M]);
    expect(
      await upgradeStatus(s.app, { host: 'app.example:80', origin: 'http://app.example' }),
    ).toBe(101);
    expect(
      await upgradeStatus(s.app, { host: 'app.example', origin: 'http://app.example:80' }),
    ).toBe(101);
    expect(
      await upgradeStatus(s.app, { host: 'app.example:8080', origin: 'http://app.example' }),
    ).toBe(403);
    expect(originAllowed('https://app.example', 'app.example:443', true)).toBe(true);
    expect(originAllowed('https://app.example:443', 'app.example', true)).toBe(true);
    expect(originAllowed('http://app.example:443', 'app.example', true)).toBe(false);
  });

  test('allowedOrigins lists extra origins; "*" allows any', async () => {
    s = await startGraphQL([M], { subscriptions: { allowedOrigins: ['https://app.example'] } });
    expect(await upgradeStatus(s.app, { origin: 'https://app.example' })).toBe(101);
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(403);
    await s.mod.close();
    s = await startGraphQL([M], { subscriptions: { allowedOrigins: '*' } });
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(101);
  });

  test('rate limiting applies to the upgrade (429)', async () => {
    s = await startGraphQL([M, RateLimitModule.forRoot({ limit: 1, window: '1m' })]);
    expect(await upgradeStatus(s.app)).toBe(101);
    expect(await upgradeStatus(s.app)).toBe(429);
  });

  test('without subscriptions there is no endpoint: the upgrade is a plain GET (400)', async () => {
    s = await startGraphQL([M], { subscriptions: false });
    expect(await upgradeStatus(s.app)).toBe(400);
  });
});

function rawSocket(started: Started, protocols: string | string[] = 'graphql-transport-ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${started.app.url.port}/graphql`, protocols);
  const messages: unknown[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  return { ws, messages, opened, closed };
}

describe('subscribe before connection_init', () => {
  test('an over-long subscribe on an uninitialized socket closes it with 4401', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(
      JSON.stringify({
        id: '1',
        type: 'subscribe',
        payload: { query: `subscription { t }${' '.repeat(200)}` },
      }),
    );
    const closed = await socket.closed;
    expect(closed).toEqual({ code: 4401, reason: 'Unauthorized' });
    expect(socket.messages).toEqual([]);
  });

  test('a short subscribe on an uninitialized socket closes it with 4401 too', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(
      JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } }),
    );
    expect((await socket.closed).code).toBe(4401);
  });
});

describe('graphql-transport-ws handshake', () => {
  test('the accepted subprotocol is echoed even when it is not offered first', async () => {
    s = await startGraphQL([M]);
    for (const offered of [
      ['foo', 'graphql-transport-ws'],
      ['graphql-ws', 'graphql-transport-ws'],
    ]) {
      const socket = rawSocket(s, offered);
      await socket.opened;
      expect(socket.ws.protocol).toBe('graphql-transport-ws');
      socket.ws.close();
      await socket.closed;
    }
  });

  test('a context factory failing at connection_init rejects the connection (fail closed)', async () => {
    let calls = 0;
    s = await startGraphQL([M], {
      context: () => {
        if (++calls === 1) throw new Error('identity store down');
        return { user: 'alice' };
      },
    });
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: 'connection_init' }));
    const closed = await socket.closed;
    expect(closed.code).toBe(4403);
    expect(socket.messages).toEqual([]);
    expect(calls).toBe(1);
  });

  test('frame checks see a type written with JSON escapes', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: 'connection_init' }));
    await until(() => socket.messages.length === 1);
    const query = `subscription { t }${' '.repeat(200)}`;
    // "\u0073ubscribe" is "subscribe": the over-long query is refused before Leaven runs it.
    socket.ws.send(`{"id":"1","type":"\\u0073ubscribe","payload":${JSON.stringify({ query })}}`);
    await until(() => socket.messages.length === 2);
    expect(socket.messages[1]).toMatchObject({
      id: '1',
      type: 'error',
      payload: [{ extensions: { code: 'BAD_USER_INPUT' } }],
    });
    // And an invalid id on an escaped "complete" closes the socket.
    socket.ws.send('{"id":"bad id!","type":"\\u0063omplete"}');
    expect((await socket.closed).code).toBe(4400);
  });

  test('ping frames are answered with pong', async () => {
    s = await startGraphQL([M]);
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: 'connection_init' }));
    await until(() => socket.messages.length === 1);
    socket.ws.send(JSON.stringify({ type: 'ping', payload: { at: 1 } }));
    await until(() => socket.messages.length === 2);
    expect(socket.messages[1]).toEqual({ type: 'pong', payload: { at: 1 } });
    socket.ws.close();
    await socket.closed;
  });

  test('an over-long subscribe reusing an active id closes the socket with 4409', async () => {
    s = await startGraphQL([M], { maxQueryLength: 100 });
    const socket = rawSocket(s);
    await socket.opened;
    socket.ws.send(JSON.stringify({ type: 'connection_init' }));
    await until(() => socket.messages.length === 1);
    socket.ws.send(
      JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { t }' } }),
    );
    await until(() => (s!.mod.get(PUBSUB) as PubSub).getSubscriberCount('t') === 1);
    socket.ws.send(
      JSON.stringify({
        id: '1',
        type: 'subscribe',
        payload: { query: `subscription { t }${' '.repeat(200)}` },
      }),
    );
    expect(await socket.closed).toEqual({ code: 4409, reason: 'Subscriber for 1 already exists' });
    expect(socket.messages).toEqual([{ type: 'connection_ack' }]);
  });
});
