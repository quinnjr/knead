import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, inject, Module, type OnModuleInit } from '@knead-js/core';
import { Controller, type Ctx, Post, WsRegistry } from '@knead-js/http';
import { readSse, Test, type TestingModule } from '../src/index.js';

// A stand-in GraphQL server: echoes POST bodies and speaks just enough graphql-transport-ws.
@Controller('/graphql')
class FakeGraphQL {
  @Post('/') async post(ctx: Ctx) {
    return { data: { echo: await ctx.json(), auth: ctx.req.headers.get('authorization') } };
  }
}

@Controller('/plain')
class PlainText {
  @Post('/') post() {
    return new Response('upstream exploded', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

const sseBody = (chunks: string[], keepOpen = false) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
  });
};
const sseResponse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

@Controller('/sse')
class FakeSse {
  @Post('/') async post(ctx: Ctx) {
    const body = (await ctx.json()) as { query: string };
    const seen = JSON.stringify({
      accept: ctx.req.headers.get('accept'),
      type: ctx.req.headers.get('content-type'),
      auth: ctx.req.headers.get('authorization'),
    });
    if (body.query.includes('forbidden')) {
      return new Response(JSON.stringify({ title: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    if (body.query.includes('json')) {
      return new Response(JSON.stringify({ data: { n: 1 } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (body.query.includes('long')) {
      return new Response('x'.repeat(2000), { status: 400 });
    }
    if (body.query.includes('cut')) {
      return sseResponse(sseBody([':\n\n', `event: next\ndata: {"data":{"n":1}}\n\n`]));
    }
    if (body.query.includes('garbage')) {
      return sseResponse(
        sseBody([`event: next\ndata: {"data":{"n":1}}\n\n`, 'event: next\ndata: not json\n\n']),
      );
    }
    if (body.query.includes('hang')) {
      return sseResponse(sseBody([':\n\n', `event: next\ndata: {"data":{"n":1}}\n\n`], true));
    }
    return sseResponse(
      sseBody([
        ':\n\n',
        `event: next\ndata: {"data":{"n":1,"seen":${seen}}}\n\n`,
        `event: next\ndata: {"data":{"n":2}}\n\n`,
        'event: complete\ndata:\n\n',
      ]),
    );
  }
}

@Injectable()
class FakeSubscriptions implements OnModuleInit {
  readonly #ws = inject(WsRegistry);
  onModuleInit() {
    this.#ws.register('/graphql', {
      upgrade: (ctx) => ({ protocol: ctx.req.headers.get('sec-websocket-protocol') }),
      message: (ws, raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; id?: string; payload?: any };
        if (msg.type === 'connection_init') {
          if (msg.payload?.deny) ws.close(4403, 'Forbidden');
          else ws.send(JSON.stringify({ type: 'connection_ack' }));
        } else if (msg.type === 'subscribe' && msg.payload.query.includes('revoke')) {
          ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { n: 1 } } }));
          ws.close(1008, 'Connection revoked');
        } else if (msg.type === 'subscribe' && msg.payload.query.includes('garbage')) {
          ws.send('not json');
        } else if (msg.type === 'subscribe') {
          const id = msg.id;
          ws.send(JSON.stringify({ type: 'ping' }));
          ws.send(JSON.stringify({ id, type: 'next', payload: { data: { n: 1 } } }));
          ws.send(
            JSON.stringify({ id, type: 'next', payload: { data: { n: 2, q: msg.payload.query } } }),
          );
          ws.send(JSON.stringify({ id, type: 'complete' }));
        }
      },
    });
  }
}

@Module({ controllers: [FakeGraphQL, PlainText, FakeSse], providers: [FakeSubscriptions] })
class FakeModule {}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

describe('TestApp.graphql', () => {
  test('POSTs query, variables and operationName as JSON with headers', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const res = await app.graphql('{ x }', {
      variables: { a: 1 },
      operationName: 'Op',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      echo: { query: '{ x }', variables: { a: 1 }, operationName: 'Op' },
      auth: 'Bearer t',
    });
  });
});

describe('TestApp.graphqlSubscribe', () => {
  test('acks, answers pings, yields next payloads and ends on complete', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.graphqlSubscribe('subscription { n }');
    const values = [];
    for await (const value of sub) values.push(value);
    expect(values).toEqual([{ data: { n: 1 } }, { data: { n: 2, q: 'subscription { n }' } }]);
  });

  test('rejects with the close code when the server refuses the connection', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    await expect(
      app.graphqlSubscribe('subscription { n }', { connectionParams: { deny: true } }),
    ).rejects.toThrow('4403');
  });

  test('an abnormal close after ack rejects next() with the code and reason', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.graphqlSubscribe('subscription { revoke }');
    expect(await sub.next()).toEqual({ value: { data: { n: 1 } }, done: false });
    // Caught with .catch(): `expect(pending).rejects` spins Bun's event loop in a way that drops
    // the close frame (the client then sees 1006).
    const failed = (await sub.next().catch((error: unknown) => error)) as Error;
    expect(failed.message).toBe('WebSocket closed: 1008 Connection revoked');
    // It stays failed: a later next() rejects too instead of looking complete.
    await expect(sub.next()).rejects.toThrow('1008');
  });

  test('a non-JSON frame fails the iterator instead of hanging it', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.graphqlSubscribe('subscription { garbage }');
    await expect(sub.next()).rejects.toThrow('not JSON');
  });
});

describe('TestApp.subscribeSse', () => {
  const opts = { path: '/sse' };

  test('yields next payloads and ends on complete', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.subscribeSse('subscription { n }', {
      ...opts,
      headers: { authorization: 'Bearer t' },
    });
    const values = [];
    for await (const value of sub) values.push(value);
    expect(values).toEqual([
      {
        data: {
          n: 1,
          seen: { accept: 'text/event-stream', type: 'application/json', auth: 'Bearer t' },
        },
      },
      { data: { n: 2 } },
    ]);
  });

  test('rejects on a 403 with the status and body', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const error = (await app
      .subscribeSse('subscription { forbidden }', opts)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('GraphQL SSE request failed (status 403): {"title":"Forbidden"}');
  });

  test('a 200 that is not an event stream rejects naming the status, type and body', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const error = (await app
      .subscribeSse('subscription { json }', opts)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      'GraphQL SSE response is not an event stream (status 200, content-type ' +
        'application/json): {"data":{"n":1}}',
    );
  });

  test('a failure body is capped at 1024 characters', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const error = (await app
      .subscribeSse('subscription { long }', opts)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(`GraphQL SSE request failed (status 400): ${'x'.repeat(1024)}…`);
  });

  test('close() aborts the stream', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.subscribeSse('subscription { hang }', opts);
    expect(await sub.next()).toEqual({ value: { data: { n: 1 } }, done: false });
    const pending = sub.next();
    await sub.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await sub.next()).toEqual({ value: undefined, done: true });
  });

  test('a next event that is not JSON makes next() reject', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.subscribeSse('subscription { garbage }', opts);
    expect(await sub.next()).toEqual({ value: { data: { n: 1 } }, done: false });
    await expect(sub.next()).rejects.toThrow('next event is not JSON');
    await expect(sub.next()).rejects.toThrow('next event is not JSON');
  });

  test('a stream cut without complete makes next() reject', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    const sub = await app.subscribeSse('subscription { cut }', opts);
    expect(await sub.next()).toEqual({ value: { data: { n: 1 } }, done: false });
    await expect(sub.next()).rejects.toThrow('without a complete event');
    await expect(sub.next()).rejects.toThrow('without a complete event');
  });
});

describe('readSse', () => {
  const collect = async (res: Response) => {
    const out = [];
    for await (const event of readSse(res)) out.push(event);
    return out;
  };

  test('parses CRLF line endings', async () => {
    const res = sseResponse(sseBody(['event: next\r\ndata: {"a":1}\r\n\r\n']));
    expect(await collect(res)).toEqual([{ event: 'next', data: '{"a":1}' }]);
  });

  test('a CRLF split across chunks still ends the event', async () => {
    const res = sseResponse(sseBody(['event: next\r', '\ndata: x\r\n\r', '\n', 'data: y\r\n\r\n']));
    expect(await collect(res)).toEqual([
      { event: 'next', data: 'x' },
      { event: 'message', data: 'y' },
    ]);
  });

  test('a bare CR is a line terminator', async () => {
    const res = sseResponse(sseBody(['event: next\rdata: x\r\r']));
    expect(await collect(res)).toEqual([{ event: 'next', data: 'x' }]);
  });

  test('joins multi-line data with newlines', async () => {
    const res = sseResponse(sseBody(['event: next\ndata: a\ndata: b\n\n']));
    expect(await collect(res)).toEqual([{ event: 'next', data: 'a\nb' }]);
  });

  test('the event name defaults to message', async () => {
    expect(await collect(sseResponse(sseBody(['data: hi\n\n'])))).toEqual([
      { event: 'message', data: 'hi' },
    ]);
  });

  test('data without a space after the colon', async () => {
    expect(await collect(sseResponse(sseBody(['data:x\n\n'])))).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  test('skips keep-alive comments', async () => {
    expect(await collect(sseResponse(sseBody([':\n\n', ': ping\n\ndata: x\n\n'])))).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  test('a block split across chunks', async () => {
    const res = sseResponse(sseBody(['eve', 'nt: next\nda', 'ta: {"a"', ':1}\n', '\n']));
    expect(await collect(res)).toEqual([{ event: 'next', data: '{"a":1}' }]);
  });

  test('a response without a body is done', async () => {
    expect(await readSse(new Response(null)).next()).toEqual({ value: undefined, done: true });
  });

  test('return() before next() cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const events = readSse(sseResponse(body));
    expect(await events.return?.()).toEqual({ value: undefined, done: true });
    expect(cancelled).toBe(true);
  });
});

describe('TestApp.graphql on a non-JSON response', () => {
  test('rejects with the status and the body text', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp();
    await expect(app.graphql('{ x }', { path: '/plain' })).rejects.toThrow(
      /502.*upstream exploded/,
    );
  });
});

const hasOpenssl = Bun.which('openssl') !== null;

describe.skipIf(!hasOpenssl)('GraphQL helpers over HTTPS with a self-signed certificate', () => {
  let certDir = '';
  let certificate: { cert: Bun.BunFile; key: Bun.BunFile };
  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), 'knead-testing-tls-'));
    const key = join(certDir, 'key.pem');
    const cert = join(certDir, 'cert.pem');
    const result = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    certificate = { cert: Bun.file(cert), key: Bun.file(key) };
  });
  afterAll(() => {
    rmSync(certDir, { recursive: true, force: true });
  });

  test('graphql() accepts tls options', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp({ tls: certificate });
    expect(app.url.protocol).toBe('https:');
    const res = await app.graphql('{ x }', { tls: { rejectUnauthorized: false } });
    expect(res.status).toBe(200);
    expect(res.data?.echo).toEqual({ query: '{ x }' });
  });

  test('graphqlSubscribe() opens wss: with tls options', async () => {
    mod = await Test.createModule({ imports: [FakeModule] }).compile();
    const app = await mod.createApp({ tls: certificate });
    const sub = await app.graphqlSubscribe('subscription { n }', {
      tls: { rejectUnauthorized: false },
    });
    const values = [];
    for await (const value of sub) values.push(value);
    expect(values).toEqual([{ data: { n: 1 } }, { data: { n: 2, q: 'subscription { n }' } }]);
  });
});
