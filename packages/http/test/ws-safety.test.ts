import { afterEach, describe, expect, test } from 'bun:test';
import { ApplicationContext, inject, Module, type OnModuleInit } from '@hpmws/core';
import type { HttpApplication, ListenOptions } from '../src/application.js';
import { HttpConfigError } from '../src/exceptions.js';
import { originAllowed } from '../src/index.js';
import { LOGGER, MemoryLogger } from '../src/logger.js';
import { type WsEndpoint, type WsEndpointOptions, WsRegistry } from '../src/ws.js';
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
