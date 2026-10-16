import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module, type OnModuleInit } from '@hpmws/core';
import type { HttpApplication } from '../src/application.js';
import { APP_GUARD } from '../src/tokens.js';
import type { Ctx } from '../src/types.js';
import { WsRegistry } from '../src/ws.js';
import { start } from './helpers.js';

/** Sends a raw upgrade request and returns the response status line. */
function upgradeStatus(app: HttpApplication, headers: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port: app.port,
      socket: {
        open(sock) {
          sock.write(
            [
              'GET /live HTTP/1.1',
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

const seen: (string | null)[] = [];

class Gateway implements OnModuleInit {
  readonly ws = inject(WsRegistry);
  onModuleInit() {
    this.ws.register('/live', { upgrade: () => ({}) });
  }
}

const requireKey = (ctx: Ctx) => {
  seen.push(ctx.route === null ? null : 'route');
  return ctx.req.headers.get('x-key') === 'ok';
};

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  seen.length = 0;
});

describe('global guards on WebSocket upgrades', () => {
  test('APP_GUARD guards run on the upgrade request; false is 403', async () => {
    @Module({
      providers: [Gateway, { provide: APP_GUARD, multi: true, useValue: requireKey }],
    })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('403');
    expect(await upgradeStatus(app, ['X-Key: ok'])).toContain('101');
    expect(seen).toEqual([null, null]);
  });

  test('useGlobalGuards guards run on the upgrade request too', async () => {
    @Module({ providers: [Gateway] })
    class M {}
    const { HpmwsFactory } = await import('../src/application.js');
    const { MemoryLogger } = await import('../src/logger.js');
    app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development: false });
    app.useGlobalGuards(requireKey);
    await app.listen({ port: 0, hostname: '127.0.0.1' });
    expect(await upgradeStatus(app)).toContain('403');
    expect(await upgradeStatus(app, ['X-Key: ok'])).toContain('101');
  });
});
