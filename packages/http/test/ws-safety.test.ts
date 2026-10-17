import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { ApplicationContext, inject, Module, type OnModuleInit } from '@knead-js/core';
import type { HttpApplication, ListenOptions } from '../src/application.js';
import { Controller, Get, Post } from '../src/decorators.js';
import { HttpConfigError, TooManyRequestsException } from '../src/exceptions.js';
import { APP_GUARD, originAllowed } from '../src/index.js';
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

  test('allowedOrigins entries that could never match an Origin are configuration errors', async () => {
    const ws = await registry();
    for (const entry of [
      'https://app.example/',
      'https://app.example/path',
      'https://app.example?x=1',
      'https://user@app.example',
      'https://*.example.com',
      '*.example.com',
      'https://app.example:443',
    ]) {
      expect(
        () =>
          ws.register(
            `/x${encodeURIComponent(entry)}`,
            { upgrade: () => ({}) },
            {
              allowedOrigins: [entry],
            },
          ),
        entry,
      ).toThrow(HttpConfigError);
    }
    expect(() =>
      ws.register('/w', { upgrade: () => ({}) }, { allowedOrigins: ['https://*.example.com'] }),
    ).toThrow(/wildcards are not supported/);
    // Exact origins are accepted, case-insensitively, with an explicit non-default port.
    ws.register(
      '/ok',
      { upgrade: () => ({}) },
      {
        allowedOrigins: ['https://App.Example', 'http://localhost:5173', 'https://[::1]:8443'],
      },
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
      { idleTimeout: 961 },
      { idleTimeout: 2 ** 31 },
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

  test('maxConnectionLifetime above the setTimeout range is a configuration error', async () => {
    // setTimeout() treats a delay above 2^31 - 1 as 1 ms, which would close every socket at once.
    const ws = await registry();
    expect(() =>
      ws.register('/big', { upgrade: () => ({}) }, { maxConnectionLifetime: 2 ** 31 }),
    ).toThrow(HttpConfigError);
    ws.register('/max', { upgrade: () => ({}) }, { maxConnectionLifetime: 2 ** 31 - 1 });
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

describe('closeWhere and upgrades in progress', () => {
  test('a revocation issued during an async global guard closes the socket when it opens', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inGuard = new Promise<void>((resolve) => {
      entered = resolve;
    });
    class Gateway implements OnModuleInit {
      readonly ws = inject(WsRegistry);
      onModuleInit() {
        this.ws.register('/live', { upgrade: () => ({ user: 'eve' }) });
      }
    }
    @Module({
      providers: [
        Gateway,
        {
          provide: APP_GUARD,
          multi: true,
          useValue: async () => {
            entered();
            await gate;
            return true;
          },
        },
      ],
    })
    class M {}
    app = await start(M);
    const registry = app.get(WsRegistry);
    const socket = new WebSocket(new URL('/live', app.url).toString().replace('http', 'ws'));
    const code = new Promise<number>((resolve) => {
      socket.onclose = (e) => resolve(e.code);
    });
    await inGuard;
    expect(registry.closeWhere((ws) => (ws.data.data as { user: string }).user === 'eve')).toBe(0);
    release();
    expect(await code).toBe(1008);
  });

  test('a revocation between server.upgrade() and open is applied at open', async () => {
    const ws = await registry();
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: { user: 'eve' } };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    expect(ws.closeWhere((s) => (s.data.data as { user: string }).user === 'eve')).toBe(0);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    await ws.handler().open?.(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Connection revoked');
  });

  test('revocations from before an upgrade began, or not matching, leave it open', async () => {
    const ws = await registry();
    const early = {};
    ws.beginUpgrade(early); // keeps an upgrade in progress so predicates are recorded
    ws.closeWhere(() => true); // issued before the next upgrade starts
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: { user: 'ada' } };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.5', ctx);
    ws.closeWhere((s) => (s.data.data as { user: string }).user === 'eve');
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    await ws.handler().open?.(socket);
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe('closeWhere re-application at open (fail closed)', () => {
  const pending = async () => {
    const ws = await registry();
    const opened: unknown[] = [];
    ws.register('/x', { upgrade: () => ({}), open: (s) => void opened.push(s) });
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: { user: 'eve' } };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    return { ws, opened, socket };
  };

  test('a matching revocation closes the socket before the endpoint sees open', async () => {
    const { ws, opened, socket } = await pending();
    ws.closeWhere(() => true);
    await ws.handler().open?.(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Connection revoked');
    expect(opened).toEqual([]);
  });

  const eve = (s: WsSocket) => (s.data.data as { user: string }).user === 'eve';

  test('20k unrelated closeWhere calls do not close a legitimate upgrade; a matching one does', async () => {
    const legit = await pending();
    (legit.socket.data as { data: { user: string } }).data.user = 'ada';
    for (let i = 0; i < 20_000; i++) legit.ws.closeWhere(() => false);
    await legit.ws.handler().open?.(legit.socket);
    expect(legit.socket.close).not.toHaveBeenCalled();
    expect(legit.opened).toHaveLength(1);
    // A matching predicate pushed out by 20k others was checked when it was evicted.
    const revoked = await pending();
    revoked.ws.closeWhere(eve, 4001, 'gone');
    for (let i = 0; i < 20_000; i++) revoked.ws.closeWhere(() => false);
    await revoked.ws.handler().open?.(revoked.socket);
    expect(revoked.socket.close).toHaveBeenCalledWith(4001, 'gone');
    expect(revoked.opened).toEqual([]);
  });

  test('an upgrade still in its guards when a predicate was lost fails closed', async () => {
    const ws = await registry();
    ws.configure({ maxPendingRevocations: 10 });
    ws.register('/x', { upgrade: () => ({}) });
    const ctx = {};
    ws.beginUpgrade(ctx); // in its guards: no socket data to check a lost predicate against
    for (let i = 0; i < 11; i++) ws.closeWhere(() => false);
    const data: WsData = { endpoint: '/x', data: { user: 'ada' } };
    ws.reserve(data, '1.2.3.4', ctx);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    await ws.handler().open?.(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Revocation state unavailable');
  });

  test('expired predicates are checked against upgrades with socket data first', async () => {
    const kept = await pending();
    (kept.socket.data as { data: { user: string } }).data.user = 'ada';
    kept.ws.closeWhere(eve);
    const revoked = await pending();
    revoked.ws.closeWhere(eve);
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      await kept.ws.handler().open?.(kept.socket);
      expect(kept.socket.close).not.toHaveBeenCalled();
      await revoked.ws.handler().open?.(revoked.socket);
      expect(revoked.socket.close).toHaveBeenCalledWith(1008, 'Connection revoked');
    } finally {
      setSystemTime();
    }
  });

  test('a slow upgrade (over 30s) fails closed only if it missed a revocation', async () => {
    const slow = await pending();
    (slow.socket.data as { data: { user: string } }).data.user = 'ada';
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      expect(slow.ws.upgradesInProgress).toBe(0);
      await slow.ws.handler().open?.(slow.socket);
      expect(slow.socket.close).not.toHaveBeenCalled();
    } finally {
      setSystemTime();
    }
    const missed = await pending();
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      expect(missed.ws.upgradesInProgress).toBe(0);
      // Nothing counts as pending any more, so this predicate is not kept for it.
      missed.ws.closeWhere(() => false);
      await missed.ws.handler().open?.(missed.socket);
      expect(missed.socket.close).toHaveBeenCalledWith(1008, 'Revocation state unavailable');
    } finally {
      setSystemTime();
    }
  });

  test("an older kept predicate expiring never lowers a newer upgrade's checked mark", async () => {
    const ws = await registry();
    ws.register('/x', { upgrade: () => ({}) });
    const first = {};
    ws.beginUpgrade(first);
    ws.closeWhere(() => false); // kept for the first upgrade
    ws.endUpgrade(first);
    ws.closeWhere(() => false); // nothing pending: #lostSeq moves forward
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: { user: 'ada' } };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      await ws.handler().open?.(socket);
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      setSystemTime();
    }
  });

  test('an evicted predicate that reads only ws.data is evaluated; one reading more fails closed', async () => {
    const dataOnly = await pending();
    dataOnly.ws.configure({ maxPendingRevocations: 1 });
    dataOnly.ws.closeWhere((s) => (s.data.data as { user: string }).user === 'nobody');
    dataOnly.ws.closeWhere(() => false); // evicts the first: evaluated, no match
    await dataOnly.ws.handler().open?.(dataOnly.socket);
    expect(dataOnly.socket.close).not.toHaveBeenCalled();

    const nosy = await pending();
    nosy.ws.configure({ maxPendingRevocations: 1 });
    nosy.ws.closeWhere((s) => s.remoteAddress === '10.0.0.1');
    nosy.ws.closeWhere(() => false); // evicts it: it read remoteAddress, so not evaluated
    await nosy.ws.handler().open?.(nosy.socket);
    expect(nosy.socket.close).toHaveBeenCalledWith(1008, 'Revocation state unavailable');
  });

  test('an idle registry drops its kept predicates (closeWhere with nothing pending, or a close)', async () => {
    const ws = await registry();
    ws.register('/x', { upgrade: () => ({}) });
    const ctx = {};
    ws.beginUpgrade(ctx);
    ws.closeWhere(() => false);
    expect(ws.keptRevocations).toBe(1);
    ws.endUpgrade(ctx);
    ws.closeWhere(() => false); // nothing pending
    expect(ws.keptRevocations).toBe(0);

    const other = {};
    ws.beginUpgrade(other);
    ws.closeWhere(() => false);
    ws.endUpgrade(other);
    expect(ws.keptRevocations).toBe(1);
    const socket = {
      data: { endpoint: '/x', data: null },
      close: mock(() => {}),
    } as unknown as WsSocket;
    await ws.handler().close?.(socket, 1000, '');
    expect(ws.keptRevocations).toBe(0);
  });

  test('20k beginUpgrade and closeWhere calls stay under 100 ms', async () => {
    const ws = await registry();
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) {
      ws.beginUpgrade({});
      ws.closeWhere(() => false);
    }
    expect(performance.now() - started).toBeLessThan(100);
  });

  test('maxPendingRevocations is validated', async () => {
    const ws = await registry();
    for (const maxPendingRevocations of [0, -1, 1.5]) {
      expect(() => ws.configure({ maxPendingRevocations })).toThrow(HttpConfigError);
    }
  });

  test('upgrades that never open stop counting: failed, and timed out', async () => {
    let allow = false;
    class Gateway implements OnModuleInit {
      readonly ws = inject(WsRegistry);
      onModuleInit() {
        this.ws.register('/live', { upgrade: () => ({}) });
      }
    }
    @Module({
      providers: [Gateway, { provide: APP_GUARD, multi: true, useValue: () => allow }],
    })
    class M {}
    app = await start(M);
    const registryOf = app.get(WsRegistry);
    expect(await upgradeStatus(app, '/live')).toContain('403');
    expect(registryOf.upgradesInProgress).toBe(0);
    allow = true;
    // An upgrade that was reserved but never opened (aborted) is dropped after its TTL.
    registryOf.beginUpgrade({});
    expect(registryOf.upgradesInProgress).toBe(1);
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      expect(registryOf.upgradesInProgress).toBe(0);
    } finally {
      setSystemTime();
    }
  });
});

describe('WebSocket endpoints covered by a parametric or wildcard GET route', () => {
  const opened: string[] = [];
  const gateway = (path: string) => {
    class Gateway implements OnModuleInit {
      readonly ws = inject(WsRegistry);
      onModuleInit() {
        this.ws.register(path, { upgrade: () => ({}), open: () => void opened.push(path) });
      }
    }
    return Gateway;
  };

  test('a SPA @Get("/*") does not swallow the upgrade of an endpoint', async () => {
    @Controller('/')
    class Spa {
      @Get('/*') page() {
        return 'spa';
      }
    }
    @Module({ controllers: [Spa], providers: [gateway('/ws/live')] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app, '/ws/live')).toContain('101');
    // Plain GETs still reach the route.
    expect(await (await fetch(new URL('/ws/live', app.url))).text()).toBe('spa');
  });

  test('a handshake to a root @Get("/*") path without an endpoint is an ordinary GET', async () => {
    @Controller('/')
    class Spa {
      @Get('/*') page() {
        return 'spa';
      }
    }
    @Module({ controllers: [Spa], providers: [gateway('/ws/live')] })
    class M {}
    app = await start(M);
    // Bun hands handshakes for a root "/*" to fetch, not to the route.
    expect(await upgradeStatus(app, '/other')).toContain('200');
    expect(await upgradeStatus(app, '/a/b')).toContain('200');
    expect(await upgradeStatus(app, '/ws/live')).toContain('101');
  });

  test('a handshake to a root @Post("/*") path is still 405 without GET', async () => {
    @Controller('/')
    class Sink {
      @Post('/*') take() {
        return 'ok';
      }
    }
    @Module({ controllers: [Sink], providers: [gateway('/ws/live')] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app, '/other')).toContain('405');
  });

  test('a prefixed wildcard @Get("/ws/*") does not swallow the upgrade of an endpoint', async () => {
    @Controller('/ws')
    class Files {
      @Get('/*') file() {
        return 'file';
      }
    }
    @Module({ controllers: [Files], providers: [gateway('/ws/live')] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app, '/ws/live')).toContain('101');
    expect(await (await fetch(new URL('/ws/live', app.url))).text()).toBe('file');
    // An upgrade to a covered path without an endpoint is still an ordinary GET of the route.
    expect(await upgradeStatus(app, '/ws/other')).toContain('200');
  });

  test('a GET /ws/:id route does not swallow the upgrade of /ws/live', async () => {
    @Controller('/ws')
    class Rooms {
      @Get('/:id') room(ctx: { params: { id: string } }) {
        return ctx.params.id;
      }
    }
    @Module({ controllers: [Rooms], providers: [gateway('/ws/live')] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app, '/ws/live')).toContain('101');
    expect(await (await fetch(new URL('/ws/live', app.url))).text()).toBe('live');
  });

  test('the covering route guards do not apply; global guards still do', async () => {
    let allow = false;
    @Controller('/', { guards: [() => false] })
    class Spa {
      @Get('/:page') page() {
        return 'spa';
      }
    }
    @Module({
      controllers: [Spa],
      providers: [gateway('/live'), { provide: APP_GUARD, multi: true, useValue: () => allow }],
    })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app, '/live')).toContain('403');
    allow = true;
    expect(await upgradeStatus(app, '/live')).toContain('101');
  });
});

describe('explicit undefined WebSocket options keep their defaults', () => {
  test('messageRate, closeOnBackpressureLimit and the other limits', async () => {
    const ws = await registry();
    ws.configure({
      messageRate: undefined,
      closeOnBackpressureLimit: undefined,
      maxPayloadLength: undefined,
      backpressureLimit: undefined,
      idleTimeout: undefined,
      maxConnectionsPerIp: undefined,
      ipv6Subnet: undefined,
      maxConnections: undefined,
      maxPendingRevocations: undefined,
    });
    expect(ws.handler()).toMatchObject({
      maxPayloadLength: 256 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
    });
    expect(ws.maxPendingRevocations).toBe(10_000);
    const seen: string[] = [];
    ws.register('/a', { upgrade: () => ({}), message: (_s, m) => void seen.push(String(m)) });
    const socket = fakeSocket('/a');
    await ws.handler().open!(socket);
    for (let i = 0; i < 101; i++) await ws.handler().message!(socket, `m${i}`);
    expect(seen).toHaveLength(100);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Message rate exceeded');
    const datas = Array.from({ length: 100 }, () => ({}));
    for (const data of datas) ws.reserve(data, '10.0.0.1');
    expect(() => ws.reserve({}, '10.0.0.1')).toThrow(TooManyRequestsException);
  });

  test('closeOnBackpressureLimit must be a boolean', async () => {
    const ws = await registry();
    for (const closeOnBackpressureLimit of ['yes', 1, null]) {
      expect(() =>
        ws.configure({ closeOnBackpressureLimit } as unknown as {
          closeOnBackpressureLimit: boolean;
        }),
      ).toThrow(HttpConfigError);
    }
    ws.configure({ closeOnBackpressureLimit: false });
    expect(ws.handler().closeOnBackpressureLimit).toBe(false);
  });
});

describe('slots of upgrades that never open', () => {
  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

  const reserved = async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1, maxConnections: 1 });
    const opened: unknown[] = [];
    ws.register('/x', { upgrade: () => ({}), open: (s) => void opened.push(s) });
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: null, ip: '1.2.3.4' };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    return { ws, opened, socket };
  };

  test('are released when the upgrade expires', async () => {
    const { ws } = await reserved();
    expect(() => ws.reserve({}, '1.2.3.4')).toThrow();
    later(31_000);
    try {
      expect(ws.upgradesInProgress).toBe(0);
      ws.reserve({}, '1.2.3.4');
    } finally {
      setSystemTime();
    }
  });

  test('a late open re-takes its slot, which its close returns', async () => {
    const { ws, opened, socket } = await reserved();
    later(31_000);
    try {
      expect(ws.upgradesInProgress).toBe(0);
      await ws.handler().open!(socket);
      expect(socket.close).not.toHaveBeenCalled();
      expect(opened).toHaveLength(1);
      expect(() => ws.reserve({}, '1.2.3.4')).toThrow();
      await ws.handler().close!(socket, 1000, '');
      ws.reserve({}, '1.2.3.4');
    } finally {
      setSystemTime();
    }
  });

  test('a late open whose slot was taken meanwhile is closed with 1013', async () => {
    const { ws, opened, socket } = await reserved();
    later(31_000);
    try {
      expect(ws.upgradesInProgress).toBe(0);
      const other = {};
      ws.reserve(other, '1.2.3.4');
      await ws.handler().open!(socket);
      expect(socket.close).toHaveBeenCalledWith(1013, 'Too many WebSocket connections');
      expect(opened).toEqual([]);
      // Its close does not return the slot it does not hold.
      await ws.handler().close!(socket, 1013, '');
      expect(() => ws.reserve({}, '1.2.3.4')).toThrow();
      ws.release(other);
      ws.reserve({}, '1.2.3.4');
    } finally {
      setSystemTime();
    }
  });

  test('an upgrade that expired in its guards and then never opens returns its slot', async () => {
    const ws = await registry();
    ws.configure({ maxConnectionsPerIp: 1, maxConnections: 1 });
    ws.register('/x', { upgrade: () => ({}) });
    const ctx = {};
    ws.beginUpgrade(ctx);
    later(31_000); // a guard took over 30s
    try {
      expect(ws.upgradesInProgress).toBe(0);
      ws.reserve({ endpoint: '/x', data: null }, '1.2.3.4', ctx);
      expect(() => ws.reserve({}, '1.2.3.4')).toThrow();
      later(31_000); // its socket never opens
      expect(ws.upgradesInProgress).toBe(0);
      ws.reserve({}, '1.2.3.4');
    } finally {
      setSystemTime();
    }
  });

  test('an upgrade that expired in its guards still fails closed at a late open', async () => {
    const ws = await registry();
    ws.configure({ maxPendingRevocations: 1 });
    const opened: unknown[] = [];
    ws.register('/x', { upgrade: () => ({}), open: (s) => void opened.push(s) });
    const ctx = {};
    ws.beginUpgrade(ctx);
    // Lost while the upgrade was in its guards: never checked against it.
    ws.closeWhere(() => false);
    ws.closeWhere(() => false);
    later(31_000);
    try {
      expect(ws.upgradesInProgress).toBe(0);
      const data: WsData = { endpoint: '/x', data: null };
      ws.reserve(data, '1.2.3.4', ctx);
      const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
        close: ReturnType<typeof mock>;
      };
      await ws.handler().open!(socket);
      expect(socket.close).toHaveBeenCalledWith(1008, 'Revocation state unavailable');
      expect(opened).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test('the endpoint gets no close for a late open it never saw (1013)', async () => {
    const { ws, socket } = await reserved();
    const events: string[] = [];
    ws.register('/y', {
      upgrade: () => ({}),
      open: () => void events.push('open'),
      message: () => void events.push('message'),
      close: () => void events.push('close'),
      drain: () => void events.push('drain'),
    });
    (socket.data as { endpoint: string }).endpoint = '/y';
    later(31_000);
    try {
      expect(ws.upgradesInProgress).toBe(0);
      ws.reserve({}, '1.2.3.4');
      await ws.handler().open!(socket);
      expect(socket.close).toHaveBeenCalledWith(1013, 'Too many WebSocket connections');
      await ws.handler().message!(socket, 'x');
      await ws.handler().drain!(socket);
      await ws.handler().close!(socket, 1013, '');
      expect(events).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});

describe('endpoint lifecycle', () => {
  test('a socket revoked before open never reaches message, drain or close', async () => {
    const ws = await registry();
    const events: string[] = [];
    ws.register('/x', {
      upgrade: () => ({}),
      open: () => void events.push('open'),
      message: () => void events.push('message'),
      close: () => void events.push('close'),
      drain: () => void events.push('drain'),
    });
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: null };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    ws.closeWhere(() => true);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    await ws.handler().open!(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Connection revoked');
    await ws.handler().message!(socket, 'x');
    await ws.handler().drain!(socket);
    await ws.handler().close!(socket, 1008, 'Connection revoked');
    expect(events).toEqual([]);
  });

  test('an open handler that throws closes the socket with 1011 (fails closed)', async () => {
    const ws = await registry();
    const events: string[] = [];
    ws.register('/x', {
      upgrade: () => ({}),
      open: async () => {
        await Bun.sleep(0);
        throw new Error('no session');
      },
      close: (_s, code) => void events.push(`close:${code}`),
    });
    const socket = fakeSocket('/x');
    await ws.handler().open!(socket);
    expect(socket.close).toHaveBeenCalledWith(1011, 'Internal error');
    // The endpoint saw open, so it still gets its close to clean up.
    await ws.handler().close!(socket, 1011, 'Internal error');
    expect(events).toEqual(['close:1011']);
  });

  test('a real client is disconnected with 1011 when open throws', async () => {
    app = await startWith({
      '/boom': {
        endpoint: {
          open() {
            throw new Error('no session');
          },
        },
      },
    });
    const socket = await connect(app, '/boom');
    expect(await closed(socket)).toBe(1011);
  });
});

describe('closeWhere: one rule for open and upgrading sockets', () => {
  test('a truthy (non-boolean) predicate result closes an upgrading socket at open', async () => {
    const ws = await registry();
    ws.register('/x', { upgrade: () => ({}) });
    const ctx = {};
    const data: WsData = { endpoint: '/x', data: null };
    ws.beginUpgrade(ctx);
    ws.reserve(data, '1.2.3.4', ctx);
    const socket = { data, close: mock(() => {}) } as unknown as WsSocket & {
      close: ReturnType<typeof mock>;
    };
    ws.closeWhere((() => 1) as unknown as (s: WsSocket) => boolean);
    await ws.handler().open!(socket);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Connection revoked');
  });
});
