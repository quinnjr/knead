import { describe, expect, test } from 'bun:test';
import { ApplicationContext, inject, Module } from '@knead-js/core';
import { KneadFactory } from '../src/application.js';
import { Controller, Get } from '../src/decorators.js';
import { HttpConfigError, HttpException } from '../src/exceptions.js';
import { LOGGER, MemoryLogger } from '../src/logger.js';
import { WsRegistry } from '../src/ws.js';
import { start } from './helpers.js';

async function registry(logger = new MemoryLogger()): Promise<WsRegistry> {
  @Module({ providers: [{ provide: LOGGER, useValue: logger }, WsRegistry] })
  class M {}
  return (await ApplicationContext.create(M)).get(WsRegistry);
}

function statusOf(fn: () => void): number | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HttpException ? error.status : -1;
  }
  return undefined;
}

describe('WsRegistry stream slots', () => {
  test('openStream counts against maxConnectionsPerIp shared with sockets', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1 });
    const first = {};
    ws.openStream(first, '1.2.3.4', () => {});
    let message = '';
    try {
      ws.openStream({}, '1.2.3.4', () => {});
    } catch (error) {
      expect((error as HttpException).status).toBe(429);
      message = (error as Error).message;
    }
    expect(message).toBe('Too many streaming connections from this address.');
    // A WebSocket upgrade from the same address shares the slot.
    expect(statusOf(() => ws.reserve({}, '1.2.3.4'))).toBe(429);
    ws.closeStream(first);
    expect(statusOf(() => ws.openStream({}, '1.2.3.4', () => {}))).toBeUndefined();
  });

  test('the socket messages are unchanged', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1 });
    ws.reserve({}, '1.2.3.4');
    expect(() => ws.reserve({}, '1.2.3.4')).toThrow(
      'Too many WebSocket connections from this address.',
    );
  });

  test('openStream respects maxConnections with 503', async () => {
    const ws = await registry();
    ws.configure({ maxConnections: 1 });
    ws.openStream({}, '1.2.3.4', () => {});
    let message = '';
    try {
      ws.openStream({}, '5.6.7.8', () => {});
    } catch (error) {
      expect((error as HttpException).status).toBe(503);
      message = (error as Error).message;
    }
    expect(message).toBe('Too many streaming connections.');
  });

  test('closeStream twice is a no-op', async () => {
    const ws = await registry();
    ws.configure({ maxConnections: 1 });
    const data = {};
    ws.openStream(data, '1.2.3.4', () => {});
    ws.closeStream(data);
    ws.closeStream(data);
    ws.openStream({}, '1.2.3.4', () => {});
    // The counter did not go negative: the limit of 1 still holds.
    expect(statusOf(() => ws.openStream({}, '5.6.7.8', () => {}))).toBe(503);
  });

  test('endStreams calls each end once and survives a throwing end', async () => {
    const logger = new MemoryLogger();
    const ws = await registry(logger);
    const calls: string[] = [];
    ws.openStream({}, '1.2.3.4', () => {
      calls.push('a');
      throw new Error('boom');
    });
    ws.openStream({}, '1.2.3.4', () => calls.push('b'));
    const closed = {};
    ws.openStream(closed, '1.2.3.4', () => calls.push('closed'));
    ws.closeStream(closed);
    ws.endStreams();
    ws.endStreams();
    expect(calls).toEqual(['a', 'b']);
    const errors = logger.entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Ending a stream at shutdown failed');
  });

  test('openStream after endStreams is refused with 503, until the next configure', async () => {
    const ws = await registry();
    ws.endStreams();
    let ended = false;
    let message = '';
    try {
      ws.openStream({}, '1.2.3.4', () => {
        ended = true;
      });
    } catch (error) {
      expect((error as HttpException).status).toBe(503);
      message = (error as Error).message;
    }
    expect(message).toBe('The server is shutting down.');
    expect(ended).toBe(false);
    ws.configure({ maxConnectionsPerIp: 1 });
    const data = {};
    ws.openStream(data, '1.2.3.4', () => {});
    // The refused stream took no slot.
    ws.closeStream(data);
    expect(statusOf(() => ws.openStream({}, '1.2.3.4', () => {}))).toBeUndefined();
  });

  test('openStream refuses a data object that already holds a slot', async () => {
    const ws = await registry();
    ws.configure({ maxConnections: 2 });
    const data = {};
    ws.openStream(data, '1.2.3.4', () => {});
    expect(() => ws.openStream(data, '1.2.3.4', () => {})).toThrow(
      'openStream: this data object already holds a connection slot.',
    );
    const reserved = {};
    ws.reserve(reserved, '1.2.3.4');
    expect(() => ws.openStream(reserved, '1.2.3.4', () => {})).toThrow('already holds');
    // Neither refused call took a slot: one closeStream frees room for one more.
    ws.closeStream(data);
    expect(statusOf(() => ws.openStream({}, '5.6.7.8', () => {}))).toBeUndefined();
    expect(statusOf(() => ws.openStream({}, '5.6.7.8', () => {}))).toBe(503);
  });

  test('holdSlot keeps a released socket slot until every hold is done', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1 });
    const data = {};
    ws.reserve(data, '1.2.3.4');
    const first = ws.holdSlot(data);
    const second = ws.holdSlot(data);
    // The socket closed: its slot stays taken while onConnect work is pending.
    ws.release(data);
    expect(statusOf(() => ws.reserve({}, '1.2.3.4'))).toBe(429);
    first();
    first();
    expect(statusOf(() => ws.reserve({}, '1.2.3.4'))).toBe(429);
    second();
    const next = {};
    expect(statusOf(() => ws.reserve(next, '1.2.3.4'))).toBeUndefined();
    // A hold that ends before the socket closes changes nothing: release() frees the slot.
    ws.holdSlot(next)();
    ws.release(next);
    expect(statusOf(() => ws.reserve({}, '1.2.3.4'))).toBeUndefined();
  });

  test('httpIdleTimeout records the idleTimeout of the last configure (default 10)', async () => {
    const ws = await registry();
    expect(ws.httpIdleTimeout).toBe(10);
    ws.configure({}, { idleTimeout: 4 });
    expect(ws.httpIdleTimeout).toBe(4);
    ws.configure({}, { idleTimeout: 0 });
    expect(ws.httpIdleTimeout).toBe(0);
    ws.configure({});
    expect(ws.httpIdleTimeout).toBe(10);
  });
});

describe('WsRegistry keep-alive check', () => {
  test('configure rejects a keep-alive above half the HTTP idle timeout', async () => {
    const ws = await registry();
    ws.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    expect(() => ws.configure({}, {})).toThrow(HttpConfigError);
    expect(() => ws.configure({}, {})).toThrow(
      'GraphQL SSE keep-alive interval (10000 ms) must be at most half the HTTP idleTimeout ' +
        '(10 s, so at most 5000 ms)',
    );
    expect(() => ws.configure({}, { idleTimeout: 19 })).toThrow(HttpConfigError);
    expect(() => ws.configure({}, { idleTimeout: 20 })).not.toThrow();
    expect(() => ws.configure({}, { idleTimeout: 0 })).not.toThrow();
    const half = await registry();
    half.requireKeepAliveBelowIdle('GraphQL SSE', 5_000);
    expect(() => half.configure({}, {})).not.toThrow();
    const over = await registry();
    over.requireKeepAliveBelowIdle('GraphQL SSE', 5_001);
    expect(() => over.configure({}, {})).toThrow(HttpConfigError);
  });

  test('a label recorded again replaces its keep-alive instead of adding one', async () => {
    const ws = await registry();
    ws.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    ws.requireKeepAliveBelowIdle('GraphQL SSE', 1_000);
    expect(() => ws.configure({}, {})).not.toThrow();
    ws.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    expect(() => ws.configure({}, {})).toThrow('(10000 ms)');
  });

  test('configure warns once for long-lived streams with an idleTimeout of 1 to 4 s', async () => {
    const warnings = (logger: MemoryLogger) =>
      logger.entries.filter((e) => e.level === 'warn' && e.message.includes('idleTimeout'));
    for (const idleTimeout of [1, 3, 4]) {
      const logger = new MemoryLogger();
      const ws = await registry(logger);
      ws.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      ws.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      ws.configure({}, { idleTimeout });
      expect(warnings(logger)).toHaveLength(1);
      expect(warnings(logger)[0]!.message).toContain('GraphQL SSE subscriptions at /graphql');
    }
    for (const idleTimeout of [0, 5, undefined]) {
      const logger = new MemoryLogger();
      const ws = await registry(logger);
      ws.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      ws.configure({}, { idleTimeout });
      expect(warnings(logger)).toHaveLength(0);
    }
    const logger = new MemoryLogger();
    const ws = await registry(logger);
    ws.configure({}, { idleTimeout: 3 });
    expect(warnings(logger)).toHaveLength(0);
  });

  test('listen() rejects a keep-alive above half the idleTimeout', async () => {
    @Module({})
    class M {}
    const app = await KneadFactory.create(M, { logger: new MemoryLogger(), development: false });
    app.get(WsRegistry).requireKeepAliveBelowIdle('GraphQL SSE', 5_000);
    await expect(app.listen({ port: 0, hostname: '127.0.0.1', idleTimeout: 5 })).rejects.toThrow(
      HttpConfigError,
    );
    await app.close();
  });
});

describe('application shutdown', () => {
  test('close() ends open streams before draining', async () => {
    let ended = 0;
    @Controller('/')
    class StreamController {
      readonly #ws = inject(WsRegistry);

      @Get('stream')
      stream(): Response {
        const data = {};
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode(': open\n\n'));
          },
        });
        this.#ws.openStream(data, undefined, () => {
          ended++;
          this.#ws.closeStream(data);
          controller.close();
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
    }
    @Module({ controllers: [StreamController] })
    class M {}
    const app = await start(M, { shutdownTimeout: 10_000 });
    const res = await fetch(`http://127.0.0.1:${app.port}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ended).toBe(1);
    await reader.cancel().catch(() => {});
  });
});
