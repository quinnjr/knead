// Unit tests for hpmws's own WebSocket defences. Leaven's handler is replaced by a stub, so each
// defence is exercised without Leaven's overlapping protections (each test fails when the
// defence it names is removed).
import { describe, expect, test } from 'bun:test';
import { MemoryLogger, type WsSocket } from '@hpmws/http';
import type { WebSocketHandlerConfig } from '@leaven-graphql/ws';
import { OperationContext } from '../src/context.js';
import type { GraphQLRuntime } from '../src/runtime.js';
import { createSubscriptionEndpoint } from '../src/subscriptions.js';

type Config = WebSocketHandlerConfig<OperationContext>;
type Socket = Parameters<NonNullable<Config['onSubscribe']>>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An async iterator that records return() calls. */
function fakeIterator() {
  const it = {
    returned: 0,
    [Symbol.asyncIterator]() {
      return it;
    },
    next: () => new Promise<IteratorResult<unknown>>(() => {}),
    async return() {
      it.returned++;
      return { value: undefined, done: true as const };
    },
  };
  return it;
}

function setup() {
  let config!: Config;
  let socket!: Socket;
  const reached: string[] = [];
  const results: ReturnType<typeof deferred<unknown>>[] = [];
  const runtime = {
    schema: {},
    logger: new MemoryLogger(),
    masking: { maskErrors: true, logger: new MemoryLogger() },
    options: { maxQueryLength: false },
    executor: {
      subscribe: () => {
        const result = deferred<unknown>();
        results.push(result);
        return result.promise;
      },
      execute: async () => ({ response: {} }),
    },
    createOperationContext: async () => new OperationContext({} as never, {}, ['subscription']),
  } as unknown as GraphQLRuntime;
  const endpoint = createSubscriptionEndpoint(runtime, {}, (c) => {
    config = c;
    return {
      handleOpen: (s) => {
        socket = s;
      },
      handleMessage: async (_s, message) => {
        reached.push(JSON.parse(String(message)).type);
      },
      handleClose: async () => {},
    };
  });
  const closes: number[] = [];
  const ws = {
    data: { endpoint: '/graphql', data: { http: {} } },
    send: () => 0,
    close: (code: number) => closes.push(code),
  } as unknown as WsSocket;
  endpoint.open?.(ws);
  /** Leaven's part of a subscribe up to executor.subscribe; resolve it with `results[n]`. */
  const subscribe = async (id: string) => {
    const request = { query: 'subscription { t }' };
    await config.onSubscribe?.(socket, id, request);
    const op = await config.context?.(socket, request);
    const executor = config.subscriptionManager?.executor as unknown as {
      subscribe(r: unknown, c: unknown): Promise<unknown>;
    };
    return executor.subscribe(request, op);
  };
  const send = async (message: object) => {
    await endpoint.message?.(ws, JSON.stringify(message));
  };
  const close = async () => {
    await endpoint.close?.(ws, 1000, '');
  };
  /** Waits until executor.subscribe has been called `n` times. */
  const started = async (n: number) => {
    while (results.length < n) await Bun.sleep(1);
  };
  return {
    endpoint,
    ws,
    reached,
    results,
    closes,
    subscribe,
    send,
    close,
    started,
    config: () => config,
    socket: () => socket,
  };
}

describe('createSubscriptionEndpoint defences (Leaven stubbed)', () => {
  test('initStarted: a second connection_init closes with 4429 and never reaches Leaven', async () => {
    const t = setup();
    await t.send({ type: 'connection_init' });
    await t.send({ type: 'connection_init' });
    expect(t.reached).toEqual(['connection_init']);
    expect(t.closes).toEqual([4429]);
  });

  test('a subscribe that resolves after the socket closed is returned at once', async () => {
    const t = setup();
    const pending = t.subscribe('1');
    await t.started(1);
    await t.close();
    const iterator = fakeIterator();
    t.results[0]!.resolve(iterator);
    await pending;
    expect(iterator.returned).toBe(1);
  });

  test('a subscribe completed by the client before it resolved is returned at once', async () => {
    const t = setup();
    const pending = t.subscribe('1');
    await t.started(1);
    await t.send({ id: '1', type: 'complete' });
    const iterator = fakeIterator();
    t.results[0]!.resolve(iterator);
    await pending;
    expect(iterator.returned).toBe(1);
  });

  test('track(): a reused id returns the earlier iterator', async () => {
    const t = setup();
    const first = t.subscribe('1');
    await t.started(1);
    const a = fakeIterator();
    t.results[0]!.resolve(a);
    await first;
    const second = t.subscribe('1');
    await t.started(2);
    t.results[1]!.resolve(fakeIterator());
    await second;
    expect(a.returned).toBe(1);
  });

  test('close returns every tracked iterator', async () => {
    const t = setup();
    const iterators = [fakeIterator(), fakeIterator()];
    for (const [i, id] of ['1', '2'].entries()) {
      const pending = t.subscribe(id);
      await t.started(i + 1);
      t.results[i]!.resolve(iterators[i]);
      await pending;
    }
    expect(t.endpoint.stats(t.ws)).toEqual({ pending: 0, iterators: 2 });
    await t.close();
    expect(iterators.map((it) => it.returned)).toEqual([1, 1]);
  });
});
