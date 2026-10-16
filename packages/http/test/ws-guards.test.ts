import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module, type OnModuleInit } from '@knead/core';
import type { HttpApplication } from '../src/application.js';
import { Controller, Get, ModuleMiddleware } from '../src/decorators.js';
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
const upgrades: unknown[] = [];

class Gateway implements OnModuleInit {
  readonly ws = inject(WsRegistry);
  onModuleInit() {
    this.ws.register('/live', { upgrade: () => ({}) });
  }
}

const requireKey = (ctx: Ctx) => {
  seen.push(ctx.route === null ? null : 'route');
  upgrades.push(ctx.upgrade);
  return ctx.req.headers.get('x-key') === 'ok';
};

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  seen.length = 0;
  upgrades.length = 0;
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
    expect(upgrades).toEqual([{ path: '/live' }, { path: '/live' }]);
  });

  test('ctx.upgrade lets a guard tell upgrades from ordinary requests', async () => {
    const guard = (ctx: Ctx) => {
      upgrades.push(ctx.upgrade);
      return ctx.upgrade !== null || ctx.req.headers.get('x-key') === 'ok';
    };
    @Controller('/plain')
    class Plain {
      @Get('/') get() {
        return 'ok';
      }
    }
    @Module({
      controllers: [Plain],
      providers: [Gateway, { provide: APP_GUARD, multi: true, useValue: guard }],
    })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('101');
    expect((await fetch(new URL('/plain', app.url))).status).toBe(403);
    expect(upgrades).toEqual([{ path: '/live' }, null]);
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

describe('WebSocket endpoints on the path of a guarded GET route', () => {
  const AdminGuard = (ctx: Ctx) => {
    seen.push(ctx.route === null ? null : `route:${String(ctx.route.handler)}`);
    upgrades.push(ctx.upgrade);
    return ctx.req.headers.get('x-role') === 'admin';
  };

  test('the controller guard now blocks the upgrade, with ctx.route and ctx.upgrade set', async () => {
    @Controller('/', { guards: [AdminGuard], meta: { area: 'admin' } })
    class Admin {
      @Get('/live') page(ctx: Ctx) {
        return { meta: ctx.meta.area };
      }
    }
    @Module({ controllers: [Admin], providers: [Gateway] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('403');
    expect(await upgradeStatus(app, ['X-Role: admin'])).toContain('101');
    expect(seen).toEqual(['route:page', 'route:page']);
    expect(upgrades).toEqual([{ path: '/live' }, { path: '/live' }]);
    // The route itself still answers ordinary GETs.
    const res = await fetch(new URL('/live', app.url), { headers: { 'x-role': 'admin' } });
    expect(await res.json()).toEqual({ meta: 'admin' });
  });

  test('route guards and module middleware run on the upgrade too, in order', async () => {
    const order: string[] = [];
    @Controller('/')
    class Live {
      @Get('/live', {
        guards: [
          (ctx: Ctx) => {
            order.push(`guard:${ctx.meta.tag}`);
            return ctx.req.headers.has('x-ok');
          },
        ],
        meta: { tag: 'live' },
      })
      page() {
        return 'page';
      }
    }
    @Module({ controllers: [Live], providers: [Gateway] })
    @ModuleMiddleware({
      use: (_ctx: Ctx, next: () => Promise<Response>) => {
        order.push('module-mw');
        return next();
      },
    })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('403');
    expect(await upgradeStatus(app, ['X-Ok: 1'])).toContain('101');
    expect(order).toEqual(['module-mw', 'guard:live', 'module-mw', 'guard:live']);
  });

  test("the route's authorize guards run on the upgrade too, after its guards, on the raw ctx", async () => {
    const order: string[] = [];
    @Controller('/')
    class Live {
      @Get('/live', {
        guards: [
          () => {
            order.push('guard');
            return true;
          },
        ],
        authorize: [
          (ctx: Ctx) => {
            order.push(`authorize:${ctx.upgrade?.path}`);
            return ctx.req.headers.get('x-role') === 'admin';
          },
        ],
      })
      page() {
        return 'page';
      }
    }
    @Module({ controllers: [Live], providers: [Gateway] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('403');
    expect(await upgradeStatus(app, ['X-Role: admin'])).toContain('101');
    expect(order).toEqual(['guard', 'authorize:/live', 'guard', 'authorize:/live']);
  });

  test('an endpoint with no GET route behaves as before (global guards only, ctx.route null)', async () => {
    @Controller('/', { guards: [AdminGuard] })
    class Other {
      @Get('/elsewhere') page() {
        return 'x';
      }
    }
    @Module({ controllers: [Other], providers: [Gateway] })
    class M {}
    app = await start(M);
    expect(await upgradeStatus(app)).toContain('101');
    expect(seen).toEqual([]);
  });
});
