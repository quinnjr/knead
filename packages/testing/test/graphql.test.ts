import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module, type OnModuleInit } from '@hpmws/core';
import { Controller, type Ctx, Post, WsRegistry } from '@hpmws/http';
import { Test, type TestingModule } from '../src/index.js';

// A stand-in GraphQL server: echoes POST bodies and speaks just enough graphql-transport-ws.
@Controller('/graphql')
class FakeGraphQL {
  @Post('/') async post(ctx: Ctx) {
    return { data: { echo: await ctx.json(), auth: ctx.req.headers.get('authorization') } };
  }
}

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

@Module({ controllers: [FakeGraphQL], providers: [FakeSubscriptions] })
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
});
