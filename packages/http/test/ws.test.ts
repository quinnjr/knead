import { describe, expect, mock, test } from 'bun:test';
import { ApplicationContext, Module } from '@knead-js/core';
import { HttpConfigError } from '../src/exceptions.js';
import { LOGGER, MemoryLogger } from '../src/logger.js';
import { type WsData, WsRegistry, type WsSocket } from '../src/ws.js';

async function registry() {
  const logger = new MemoryLogger();
  @Module({ providers: [{ provide: LOGGER, useValue: logger }, WsRegistry] })
  class M {}
  const ctx = await ApplicationContext.create(M);
  return { ws: ctx.get(WsRegistry), logger };
}

function fakeSocket(endpoint: string, data: unknown = null) {
  return {
    data: { endpoint, data } satisfies WsData,
    close: mock(() => {}),
  } as unknown as WsSocket & {
    close: ReturnType<typeof mock>;
  };
}

describe('WsRegistry', () => {
  test('register() rejects a non-object meta and freezes a copy of a valid one', async () => {
    const { ws } = await registry();
    for (const meta of ['nope', null, [1]]) {
      expect(() => ws.register('/x', { upgrade: () => ({}) }, { meta: meta as never })).toThrow(
        'meta of /x must be an object',
      );
    }
    const meta = { area: 'chat' };
    ws.register('/y', { upgrade: () => ({}) }, { meta });
    meta.area = 'changed';
    expect(ws.meta('/y')).toEqual({ area: 'chat' });
    expect(Object.isFrozen(ws.meta('/y'))).toBe(true);
    expect(ws.meta('/nope')).toBeUndefined();
  });

  test('normalizes paths and rejects duplicates', async () => {
    const { ws } = await registry();
    ws.register('chat/', { upgrade: () => ({}) });
    expect(ws.get('/chat')).toBeDefined();
    expect(() => ws.register('/chat', { upgrade: () => ({}) })).toThrow(HttpConfigError);
    expect([...ws.entries()].map(([p]) => p)).toEqual(['/chat']);
  });

  test('rejects parameter and wildcard paths', async () => {
    const { ws } = await registry();
    expect(() => ws.register('/rooms/:id', { upgrade: () => ({}) })).toThrow(
      'WebSocket endpoint paths must be exact; got /rooms/:id',
    );
    expect(() => ws.register('/files/*', { upgrade: () => ({}) })).toThrow(HttpConfigError);
    expect(() => ws.register('/files/*rest', { upgrade: () => ({}) })).toThrow(HttpConfigError);
  });

  test('registering after seal() is rejected', async () => {
    const { ws } = await registry();
    ws.seal();
    expect(() => ws.register('/late', { upgrade: () => ({}) })).toThrow(/after listen/);
  });

  test('registering a duplicate path after seal() throws the after-listen error', async () => {
    const { ws } = await registry();
    ws.register('/dup', { upgrade: () => ({}) });
    ws.seal();
    expect(() => ws.register('/dup', { upgrade: () => ({}) })).toThrow(/after listen/);
  });

  test('dispatches events to the endpoint named in socket data and tracks open sockets', async () => {
    const { ws } = await registry();
    const events: string[] = [];
    ws.register('/a', {
      upgrade: () => ({}),
      open: () => void events.push('open'),
      message: (_s, m) => void events.push(`message:${m}`),
      close: (_s, code) => void events.push(`close:${code}`),
    });
    const handler = ws.handler();
    const socket = fakeSocket('/a');
    handler.open!(socket);
    expect(ws.openSockets).toBe(1);
    await handler.message!(socket, 'hi');
    handler.close!(socket, 1000, 'bye');
    await Bun.sleep(0);
    expect(events).toEqual(['open', 'message:hi', 'close:1000']);
    expect(ws.openSockets).toBe(0);
  });

  test('handler errors are logged, not thrown', async () => {
    const { ws, logger } = await registry();
    ws.register('/b', {
      upgrade: () => ({}),
      message: () => {
        throw new Error('bad handler');
      },
    });
    const socket = fakeSocket('/b');
    await ws.handler().open!(socket);
    await ws.handler().message!(socket, 'x');
    await Bun.sleep(0);
    expect(logger.entries.some((e) => e.level === 'error' && e.message.includes('/b'))).toBe(true);
  });

  test('closeAll closes every open socket with 1001', async () => {
    const { ws } = await registry();
    ws.register('/c', { upgrade: () => ({}) });
    const a = fakeSocket('/c');
    const b = fakeSocket('/c');
    ws.handler().open!(a);
    ws.handler().open!(b);
    ws.closeAll();
    expect(a.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(b.close).toHaveBeenCalledWith(1001, 'Server shutting down');
  });
});
