import { describe, expect, test } from 'bun:test';
import { ApplicationContext, inject, Module } from '@knead-js/core';
import { KneadFactory } from '../src/application.js';
import { Controller, Get } from '../src/decorators.js';
import { HttpConfigError, HttpException } from '../src/exceptions.js';
import { LOGGER, MemoryLogger } from '../src/logger.js';
import { StreamRegistry } from '../src/streams.js';
import { WsRegistry } from '../src/ws.js';
import { start } from './helpers.js';

/** A WsRegistry and the StreamRegistry sharing its connection slots. */
async function registries(
  logger = new MemoryLogger(),
): Promise<{ ws: WsRegistry; streams: StreamRegistry }> {
  @Module({ providers: [{ provide: LOGGER, useValue: logger }, WsRegistry, StreamRegistry] })
  class M {}
  const context = await ApplicationContext.create(M);
  return { ws: context.get(WsRegistry), streams: context.get(StreamRegistry) };
}

function statusOf(fn: () => void): number | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HttpException ? error.status : -1;
  }
  return undefined;
}

describe('StreamRegistry stream slots', () => {
  test('openStream counts against maxConnectionsPerIp shared with sockets', async () => {
    const { ws, streams } = await registries();
    ws.configure({ maxConnectionsPerIp: 1 });
    const first = {};
    streams.openStream(first, '1.2.3.4', () => {});
    let message = '';
    try {
      streams.openStream({}, '1.2.3.4', () => {});
    } catch (error) {
      expect((error as HttpException).status).toBe(429);
      message = (error as Error).message;
    }
    expect(message).toBe('Too many streaming connections from this address.');
    // A WebSocket upgrade from the same address shares the slot.
    expect(statusOf(() => ws.reserve({}, '1.2.3.4'))).toBe(429);
    streams.closeStream(first);
    expect(statusOf(() => streams.openStream({}, '1.2.3.4', () => {}))).toBeUndefined();
  });

  test('the socket messages are unchanged', async () => {
    const { ws } = await registries();
    ws.configure({ maxConnectionsPerIp: 1 });
    ws.reserve({}, '1.2.3.4');
    expect(() => ws.reserve({}, '1.2.3.4')).toThrow(
      'Too many WebSocket connections from this address.',
    );
  });

  test('openStream respects maxConnections with 503', async () => {
    const { ws, streams } = await registries();
    ws.configure({ maxConnections: 1 });
    streams.openStream({}, '1.2.3.4', () => {});
    let message = '';
    try {
      streams.openStream({}, '5.6.7.8', () => {});
    } catch (error) {
      expect((error as HttpException).status).toBe(503);
      message = (error as Error).message;
    }
    expect(message).toBe('Too many streaming connections.');
  });

  test('closeStream twice is a no-op', async () => {
    const { ws, streams } = await registries();
    ws.configure({ maxConnections: 1 });
    const data = {};
    streams.openStream(data, '1.2.3.4', () => {});
    streams.closeStream(data);
    streams.closeStream(data);
    streams.openStream({}, '1.2.3.4', () => {});
    // The counter did not go negative: the limit of 1 still holds.
    expect(statusOf(() => streams.openStream({}, '5.6.7.8', () => {}))).toBe(503);
  });

  test('endStreams calls each end once and survives a throwing end', async () => {
    const logger = new MemoryLogger();
    const { streams } = await registries(logger);
    const calls: string[] = [];
    streams.openStream({}, '1.2.3.4', () => {
      calls.push('a');
      throw new Error('boom');
    });
    streams.openStream({}, '1.2.3.4', () => calls.push('b'));
    const closed = {};
    streams.openStream(closed, '1.2.3.4', () => calls.push('closed'));
    streams.closeStream(closed);
    streams.endStreams();
    streams.endStreams();
    expect(calls).toEqual(['a', 'b']);
    const errors = logger.entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Ending a stream at shutdown failed');
  });

  test('openStream after endStreams is refused with 503, until the next configure', async () => {
    const { ws, streams } = await registries();
    streams.endStreams();
    let ended = false;
    let message = '';
    try {
      streams.openStream({}, '1.2.3.4', () => {
        ended = true;
      });
    } catch (error) {
      expect((error as HttpException).status).toBe(503);
      message = (error as Error).message;
    }
    expect(message).toBe('The server is shutting down.');
    expect(ended).toBe(false);
    streams.configure();
    ws.configure({ maxConnectionsPerIp: 1 });
    const data = {};
    streams.openStream(data, '1.2.3.4', () => {});
    // The refused stream took no slot.
    streams.closeStream(data);
    expect(statusOf(() => streams.openStream({}, '1.2.3.4', () => {}))).toBeUndefined();
  });

  test('openStream refuses a data object that already holds a slot', async () => {
    const { ws, streams } = await registries();
    ws.configure({ maxConnections: 2 });
    const data = {};
    streams.openStream(data, '1.2.3.4', () => {});
    expect(() => streams.openStream(data, '1.2.3.4', () => {})).toThrow(
      'openStream: this data object already holds a connection slot.',
    );
    const reserved = {};
    ws.reserve(reserved, '1.2.3.4');
    expect(() => streams.openStream(reserved, '1.2.3.4', () => {})).toThrow('already holds');
    // Neither refused call took a slot: one closeStream frees room for one more.
    streams.closeStream(data);
    expect(statusOf(() => streams.openStream({}, '5.6.7.8', () => {}))).toBeUndefined();
    expect(statusOf(() => streams.openStream({}, '5.6.7.8', () => {}))).toBe(503);
  });

  test('holdSlot keeps a released socket slot until every hold is done', async () => {
    const { ws } = await registries();
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
    const { streams } = await registries();
    expect(streams.httpIdleTimeout).toBe(10);
    streams.configure({ idleTimeout: 4 });
    expect(streams.httpIdleTimeout).toBe(4);
    streams.configure({ idleTimeout: 0 });
    expect(streams.httpIdleTimeout).toBe(0);
    streams.configure({});
    expect(streams.httpIdleTimeout).toBe(10);
  });

  test('maxKeepAliveMs is half the recorded idle timeout, undefined without one', async () => {
    const { streams } = await registries();
    expect(streams.maxKeepAliveMs).toBe(5000);
    streams.configure({ idleTimeout: 3 });
    expect(streams.maxKeepAliveMs).toBe(1500);
    streams.configure({ idleTimeout: 0 });
    expect(streams.maxKeepAliveMs).toBeUndefined();
  });

  test('the connection slots are not part of the public API', async () => {
    const http = await import('../src/index.js');
    expect('ConnectionSlots' in http).toBe(false);
    expect('connectionSlotsOf' in http).toBe(false);
    const { ws } = await registries();
    for (const name of ['openStream', 'closeStream', 'endStreams', 'httpIdleTimeout']) {
      expect(name in ws).toBe(false);
    }
  });
});

describe('StreamRegistry keep-alive check', () => {
  test('configure rejects a keep-alive above half the HTTP idle timeout', async () => {
    const { streams } = await registries();
    streams.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    expect(() => streams.configure({})).toThrow(HttpConfigError);
    expect(() => streams.configure({})).toThrow(
      'GraphQL SSE keep-alive interval (10000 ms) must be at most half the HTTP idleTimeout ' +
        '(10 s, so at most 5000 ms)',
    );
    expect(() => streams.configure({ idleTimeout: 19 })).toThrow(HttpConfigError);
    expect(() => streams.configure({ idleTimeout: 20 })).not.toThrow();
    expect(() => streams.configure({ idleTimeout: 0 })).not.toThrow();
    const { streams: half } = await registries();
    half.requireKeepAliveBelowIdle('GraphQL SSE', 5_000);
    expect(() => half.configure({})).not.toThrow();
    const { streams: over } = await registries();
    over.requireKeepAliveBelowIdle('GraphQL SSE', 5_001);
    expect(() => over.configure({})).toThrow(HttpConfigError);
  });

  test('a label recorded again replaces its keep-alive instead of adding one', async () => {
    const { streams } = await registries();
    streams.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    streams.requireKeepAliveBelowIdle('GraphQL SSE', 1_000);
    expect(() => streams.configure({})).not.toThrow();
    streams.requireKeepAliveBelowIdle('GraphQL SSE', 10_000);
    expect(() => streams.configure({})).toThrow('(10000 ms)');
  });

  test('configure warns once for long-lived streams with an idleTimeout of 1 to 4 s', async () => {
    const warnings = (logger: MemoryLogger) =>
      logger.entries.filter((e) => e.level === 'warn' && e.message.includes('idleTimeout'));
    for (const idleTimeout of [1, 3, 4]) {
      const logger = new MemoryLogger();
      const { streams } = await registries(logger);
      streams.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      streams.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      streams.configure({ idleTimeout });
      expect(warnings(logger)).toHaveLength(1);
      expect(warnings(logger)[0]!.message).toContain('GraphQL SSE subscriptions at /graphql');
    }
    for (const idleTimeout of [0, 5, undefined]) {
      const logger = new MemoryLogger();
      const { streams } = await registries(logger);
      streams.expectLongLivedStreams('GraphQL SSE subscriptions at /graphql');
      streams.configure({ idleTimeout });
      expect(warnings(logger)).toHaveLength(0);
    }
    const logger = new MemoryLogger();
    const { streams } = await registries(logger);
    streams.configure({ idleTimeout: 3 });
    expect(warnings(logger)).toHaveLength(0);
  });

  test('listen() rejects a keep-alive above half the idleTimeout', async () => {
    @Module({})
    class M {}
    const app = await KneadFactory.create(M, { logger: new MemoryLogger(), development: false });
    app.get(StreamRegistry).requireKeepAliveBelowIdle('GraphQL SSE', 5_000);
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
      readonly #streams = inject(StreamRegistry);

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
        this.#streams.openStream(data, undefined, () => {
          ended++;
          this.#streams.closeStream(data);
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
