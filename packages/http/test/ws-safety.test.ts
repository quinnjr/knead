import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ApplicationContext, inject, Module, type OnModuleInit } from '@hpmws/core';
import type { HttpApplication, ListenOptions } from '../src/application.js';
import { HttpConfigError, TooManyRequestsException } from '../src/exceptions.js';
import { originAllowed } from '../src/index.js';
import { LOGGER, MemoryLogger } from '../src/logger.js';
import {
  type WsData,
  type WsEndpoint,
  type WsEndpointOptions,
  WsRegistry,
  type WsSocket,
} from '../src/ws.js';
import { start } from './helpers.js';

/** Sends a raw upgrade request to `path` and returns the response status line. */
function upgradeStatus(
  app: HttpApplication,
  path: string,
  headers: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port: app.port,
      socket: {
        open(sock) {
          sock.write(
            [
              `GET ${path} HTTP/1.1`,
              `Host: 127.0.0.1:${app.port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              ...headers,
              '',
              '',
            ].join('\r\n'),
          );
        },
        data(sock, chunk) {
          buf += chunk.toString();
          if (buf.includes('\r\n')) {
            resolve(buf.split('\r\n')[0] ?? '');
            sock.end();
          }
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

type Endpoints = Record<string, { endpoint?: Partial<WsEndpoint>; options?: WsEndpointOptions }>;

function gatewayModule(endpoints: Endpoints) {
  class Gateway implements OnModuleInit {
    readonly ws = inject(WsRegistry);
    onModuleInit() {
      for (const [path, { endpoint, options }] of Object.entries(endpoints)) {
        this.ws.register(path, { upgrade: () => ({}), ...endpoint }, options);
      }
    }
  }
  @Module({ providers: [Gateway] })
  class M {}
  return M;
}

async function registry(): Promise<WsRegistry> {
  @Module({ providers: [{ provide: LOGGER, useValue: new MemoryLogger() }, WsRegistry] })
  class M {}
  return (await ApplicationContext.create(M)).get(WsRegistry);
}

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const startWith = (endpoints: Endpoints, listen: ListenOptions = {}) =>
  start(gatewayModule(endpoints), listen);

describe('originAllowed', () => {
  test('no Origin header is allowed (non-browser clients)', () => {
    expect(originAllowed(null, 'example.com', false)).toBe(true);
  });

  test('same scheme and host is allowed; default ports are normalized', () => {
    expect(originAllowed('http://example.com', 'example.com', false)).toBe(true);
    expect(originAllowed('https://example.com', 'example.com', true)).toBe(true);
    expect(originAllowed('https://example.com', 'example.com:443', true)).toBe(true);
    expect(originAllowed('https://example.com:443', 'example.com', true)).toBe(true);
    expect(originAllowed('http://example.com:80', 'EXAMPLE.com:80', false)).toBe(true);
    expect(originAllowed('http://example.com:8080', 'example.com:8080', false)).toBe(true);
    expect(originAllowed('http://example.com:8080', 'example.com', false)).toBe(false);
  });

  test('a scheme mismatch is rejected', () => {
    expect(originAllowed('http://example.com', 'example.com', true)).toBe(false);
    expect(originAllowed('https://example.com', 'example.com', false)).toBe(false);
  });

  test('other hosts, "null" and malformed values are rejected', () => {
    expect(originAllowed('http://evil.example', 'example.com', false)).toBe(false);
    expect(originAllowed('null', 'example.com', false)).toBe(false);
    expect(originAllowed('not a url', 'example.com', false)).toBe(false);
    expect(originAllowed('http://example.com', null, false)).toBe(false);
    expect(originAllowed('http://example.com', 'example.com/x', false)).toBe(false);
    expect(originAllowed('http://example.com', 'u@example.com', false)).toBe(false);
  });

  test('allowed lists extra origins (normalized); "*" allows any', () => {
    const allowed = ['https://app.example'];
    expect(originAllowed('https://app.example', 'api.example', true, allowed)).toBe(true);
    expect(originAllowed('https://APP.example:443', 'api.example', true, allowed)).toBe(true);
    expect(originAllowed('http://app.example', 'api.example', true, allowed)).toBe(false);
    expect(originAllowed('null', 'api.example', true, allowed)).toBe(false);
    expect(originAllowed('https://evil.example', 'api.example', true, '*')).toBe(true);
  });
});

describe('WebSocket origin check', () => {
  test('cross-origin upgrades are rejected with 403 by default', async () => {
    app = await startWith({ '/live': {} });
    const host = `127.0.0.1:${app.port}`;
    expect(await upgradeStatus(app, '/live')).toContain('101');
    expect(await upgradeStatus(app, '/live', [`Origin: http://${host}`])).toContain('101');
    expect(await upgradeStatus(app, '/live', ['Origin: http://evil.example'])).toContain('403');
    expect(await upgradeStatus(app, '/live', [`Origin: https://${host}`])).toContain('403');
    expect(await upgradeStatus(app, '/live', ['Origin: null'])).toContain('403');
  });

  test('the endpoint is not consulted for a rejected origin', async () => {
    let calls = 0;
    app = await startWith({
      '/live': {
        endpoint: {
          upgrade: () => {
            calls++;
            return {};
          },
        },
      },
    });
    await upgradeStatus(app, '/live', ['Origin: http://evil.example']);
    expect(calls).toBe(0);
  });

  test('allowedOrigins is per endpoint', async () => {
    app = await startWith({
      '/listed': { options: { allowedOrigins: ['https://app.example'] } },
      '/any': { options: { allowedOrigins: '*' } },
      '/strict': {},
    });
    const origin = ['Origin: https://app.example'];
    expect(await upgradeStatus(app, '/listed', origin)).toContain('101');
    expect(await upgradeStatus(app, '/listed', ['Origin: https://evil.example'])).toContain('403');
    expect(await upgradeStatus(app, '/any', ['Origin: https://evil.example'])).toContain('101');
    expect(await upgradeStatus(app, '/strict', origin)).toContain('403');
  });

  test('invalid allowedOrigins entries are configuration errors', async () => {
    const ws = await registry();
    expect(() => ws.register('/x', { upgrade: () => ({}) }, { allowedOrigins: ['nope'] })).toThrow(
      HttpConfigError,
    );
  });
});

function fakeSocket(endpoint: string, data: unknown = null) {
  return {
    data: { endpoint, data } satisfies WsData,
    close: mock(() => {}),
  } as unknown as WsSocket & { close: ReturnType<typeof mock> };
}

/** Opens a WebSocket client and resolves once it is open (or rejects on error). */
function connect(app: HttpApplication, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(new URL(path, app.url).toString().replace('http', 'ws'));
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('socket error'));
  });
}

const closed = (socket: WebSocket) =>
  new Promise<number>((resolve) => {
    socket.onclose = (e) => resolve(e.code);
  });

describe('Bun WebSocket limits', () => {
  test('defaults: 256 KiB payloads, 1 MiB backpressure (closing), 120s idle timeout', async () => {
    const ws = await registry();
    ws.configure({});
    expect(ws.handler()).toMatchObject({
      maxPayloadLength: 256 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
    });
    ws.configure({
      maxPayloadLength: 1024,
      backpressureLimit: 2048,
      closeOnBackpressureLimit: false,
      idleTimeout: 30,
    });
    expect(ws.handler()).toMatchObject({
      maxPayloadLength: 1024,
      backpressureLimit: 2048,
      closeOnBackpressureLimit: false,
      idleTimeout: 30,
    });
  });

  test('a message over maxPayloadLength closes the socket', async () => {
    const received: number[] = [];
    let serverCode: number | undefined;
    app = await startWith({
      '/live': {
        endpoint: {
          message: (_ws, m) => void received.push(m.length),
          close: (_ws, code) => {
            serverCode = code;
          },
        },
      },
    });
    const socket = await connect(app, '/live');
    const code = closed(socket);
    socket.send('x'.repeat(256 * 1024 + 1));
    // Bun drops the connection without a close frame, so both sides see 1006.
    expect(await code).toBe(1006);
    for (let i = 0; i < 50 && serverCode === undefined; i++) await Bun.sleep(5);
    expect(serverCode).toBe(1006);
    expect(received).toEqual([]);
  });

  test('the default accepts a 200 KiB message (above a 100 KiB GraphQL query)', async () => {
    const received: number[] = [];
    app = await startWith({
      '/live': { endpoint: { message: (_ws, m) => void received.push(m.length) } },
    });
    const socket = await connect(app, '/live');
    socket.send('x'.repeat(200 * 1024));
    for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(10);
    expect(received).toEqual([200 * 1024]);
    socket.close();
  });

  test('listen({ websocket }) raises the payload limit', async () => {
    const received: number[] = [];
    app = await startWith(
      { '/live': { endpoint: { message: (_ws, m) => void received.push(m.length) } } },
      { websocket: { maxPayloadLength: 512 * 1024 } },
    );
    const socket = await connect(app, '/live');
    socket.send('x'.repeat(300 * 1024));
    for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(10);
    expect(received).toEqual([300 * 1024]);
    socket.close();
  });

  test('invalid limits are configuration errors', async () => {
    const ws = await registry();
    for (const bad of [
      { maxPayloadLength: 0 },
      { backpressureLimit: -1 },
      { idleTimeout: 1.5 },
      { maxConnectionsPerIp: 0 },
      { ipv6Subnet: -1 },
      { ipv6Subnet: 0 },
      { ipv6Subnet: 129 },
      { ipv6Subnet: 1.5 },
      { maxConnections: Number.NaN },
      { messageRate: { limit: 0, windowMs: 1000 } },
    ]) {
      expect(() => ws.configure(bad)).toThrow(HttpConfigError);
    }
    expect(() =>
      ws.register('/x', { upgrade: () => ({}) }, { messageRate: { limit: 1, windowMs: 0 } }),
    ).toThrow(HttpConfigError);
    expect(() => ws.register('/y', { upgrade: () => ({}) }, { maxConnectionLifetime: -5 })).toThrow(
      HttpConfigError,
    );
  });
});

describe('per-socket message rate', () => {
  const messages = async (ws: WsRegistry, socket: WsSocket, count: number) => {
    const handler = ws.handler();
    for (let i = 0; i < count; i++) await handler.message!(socket, `m${i}`);
  };

  test('by default, more than 100 messages in 10s closes with 1008', async () => {
    const ws = await registry();
    const seen: string[] = [];
    ws.register('/a', { upgrade: () => ({}), message: (_s, m) => void seen.push(String(m)) });
    const socket = fakeSocket('/a');
    ws.handler().open!(socket);
    await messages(ws, socket, 101);
    expect(seen).toHaveLength(100);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Message rate exceeded');
    await messages(ws, socket, 5);
    expect(seen).toHaveLength(100);
  });

  test('the rate is configurable per endpoint, or off', async () => {
    const ws = await registry();
    const seen: string[] = [];
    const message = (_s: WsSocket, m: string | Buffer) => void seen.push(String(m));
    ws.register(
      '/slow',
      { upgrade: () => ({}), message },
      { messageRate: { limit: 3, windowMs: 60_000 } },
    );
    ws.register('/free', { upgrade: () => ({}), message }, { messageRate: false });
    const slow = fakeSocket('/slow');
    const free = fakeSocket('/free');
    ws.handler().open!(slow);
    ws.handler().open!(free);
    await messages(ws, slow, 4);
    expect(slow.close).toHaveBeenCalledWith(1008, 'Message rate exceeded');
    expect(seen).toHaveLength(3);
    await messages(ws, free, 500);
    expect(free.close).not.toHaveBeenCalled();
    expect(seen).toHaveLength(503);
  });

  test('tokens refill over the window', async () => {
    const ws = await registry();
    let count = 0;
    ws.register(
      '/r',
      { upgrade: () => ({}), message: () => void count++ },
      { messageRate: { limit: 2, windowMs: 40 } },
    );
    const socket = fakeSocket('/r');
    ws.handler().open!(socket);
    await messages(ws, socket, 2);
    await Bun.sleep(60);
    await messages(ws, socket, 2);
    expect(count).toBe(4);
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe('connection limits', () => {
  test('maxConnectionsPerIp answers further upgrades from that IP with 429', async () => {
    app = await startWith({ '/live': {} }, { websocket: { maxConnectionsPerIp: 2 } });
    const a = await connect(app, '/live');
    const b = await connect(app, '/live');
    expect(await upgradeStatus(app, '/live')).toContain('429');
    const gone = closed(a);
    a.close();
    await gone;
    for (let i = 0; i < 50 && app.get(WsRegistry).openSockets > 1; i++) await Bun.sleep(5);
    expect(await upgradeStatus(app, '/live')).toContain('101');
    b.close();
  });

  test('maxConnections caps the total with 503', async () => {
    app = await startWith({ '/live': {} }, { websocket: { maxConnections: 1 } });
    const a = await connect(app, '/live');
    expect(await upgradeStatus(app, '/live')).toContain('503');
    a.close();
  });

  test('the per-IP limit defaults to 100', async () => {
    const ws = await registry();
    ws.configure({});
    const datas = Array.from({ length: 100 }, () => ({}));
    for (const data of datas) ws.reserve(data, '10.0.0.1');
    expect(() => ws.reserve({}, '10.0.0.1')).toThrow(TooManyRequestsException);
    ws.reserve({}, '10.0.0.2');
  });

  test('IPv6 clients are grouped by /64 by default', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 2 });
    ws.reserve({}, '2001:db8:1:2::1');
    ws.reserve({}, '2001:db8:1:2::ffff');
    expect(() => ws.reserve({}, '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toThrow(
      TooManyRequestsException,
    );
    ws.reserve({}, '2001:db8:1:3::1');
  });

  test('IPv4-mapped clients share the slot of their IPv4 address', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1 });
    ws.reserve({}, '1.2.3.4');
    expect(() => ws.reserve({}, '::ffff:1.2.3.4')).toThrow(TooManyRequestsException);
  });

  test('ipv6Subnet is configurable (128 counts full addresses)', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1, ipv6Subnet: 128 });
    ws.reserve({}, '2001:db8::1');
    ws.reserve({}, '2001:db8::2');
    expect(() => ws.reserve({}, '2001:db8::1')).toThrow(TooManyRequestsException);
  });

  test('releasing a grouped slot frees it for the whole subnet', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1 });
    const data = {};
    ws.reserve(data, '2001:db8::1');
    ws.release(data);
    ws.reserve({}, '2001:db8::2');
  });
});

describe('connection lifetime', () => {
  test('maxConnectionLifetime closes the socket with 4408', async () => {
    const ws = await registry();
    ws.register('/l', { upgrade: () => ({}) }, { maxConnectionLifetime: 20 });
    const socket = fakeSocket('/l');
    ws.handler().open!(socket);
    await Bun.sleep(50);
    expect(socket.close).toHaveBeenCalledWith(4408, 'Connection lifetime exceeded');
  });

  test('a socket closed earlier is not closed again', async () => {
    const ws = await registry();
    ws.register('/l', { upgrade: () => ({}) }, { maxConnectionLifetime: 20 });
    const socket = fakeSocket('/l');
    ws.handler().open!(socket);
    ws.handler().close!(socket, 1000, 'bye');
    await Bun.sleep(50);
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe('closeWhere', () => {
  test('closes the sockets matching the predicate and returns how many', async () => {
    const ws = await registry();
    ws.register('/c', { upgrade: () => ({}) });
    const ada = fakeSocket('/c', { user: 'ada' });
    const bob = fakeSocket('/c', { user: 'bob' });
    const ada2 = fakeSocket('/c', { user: 'ada' });
    for (const s of [ada, bob, ada2]) ws.handler().open!(s);
    const count = ws.closeWhere((s) => (s.data.data as { user: string }).user === 'ada');
    expect(count).toBe(2);
    expect(ada.close).toHaveBeenCalledWith(1008, 'Connection revoked');
    expect(ada2.close).toHaveBeenCalledWith(1008, 'Connection revoked');
    expect(bob.close).not.toHaveBeenCalled();
    ws.closeWhere(() => true, 4403, 'Signed out');
    expect(bob.close).toHaveBeenCalledWith(4403, 'Signed out');
  });

  test('a predicate that throws for one socket is logged; the others are still checked', async () => {
    const logger = new MemoryLogger();
    @Module({ providers: [{ provide: LOGGER, useValue: logger }, WsRegistry] })
    class M {}
    const ws = (await ApplicationContext.create(M)).get(WsRegistry);
    ws.register('/c', { upgrade: () => ({}) });
    const broken = fakeSocket('/c', null);
    const ada = fakeSocket('/c', { user: 'ada' });
    for (const s of [broken, ada]) ws.handler().open!(s);
    const count = ws.closeWhere((s) => (s.data.data as { user: string }).user === 'ada');
    expect(count).toBe(1);
    expect(ada.close).toHaveBeenCalled();
    expect(broken.close).not.toHaveBeenCalled();
    expect(
      logger.entries.some((e) => e.level === 'error' && e.message.includes('closeWhere')),
    ).toBe(true);
  });
});

describe('WebSocket handler errors are logged as summaries in production', () => {
  test('a throwing message handler logs Name: message, redacted, without the error object', async () => {
    app = await startWith({
      '/boom': {
        endpoint: {
          message() {
            throw Object.assign(new Error('dial redis://u:pw@h\nFAKE'), { secret: 's' });
          },
        },
      },
    });
    const socket = await connect(app, '/boom');
    socket.send('x');
    const logger = app.logger as MemoryLogger;
    for (let i = 0; i < 100 && !logger.entries.some((e) => e.level === 'error'); i++) {
      await Bun.sleep(5);
    }
    socket.close();
    const entry = logger.entries.find((e) => e.level === 'error')!;
    expect(entry.message).toContain('WebSocket message handler for /boom threw');
    expect(entry.message).toContain('Error: dial redis://***@h\\nFAKE');
    expect(entry.meta).toEqual([]);
  });
});
