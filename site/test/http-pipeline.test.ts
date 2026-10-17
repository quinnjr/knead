// Pins the behaviour described on guide/middleware, guide/guards, guide/exception-filters,
// guide/server and guide/websockets.
import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { Module } from '@knead-js/core';
import {
  APP_GUARD,
  APP_MIDDLEWARE,
  Catch,
  Controller,
  type Ctx,
  checkBunVersion,
  compareVersions,
  type ExceptionFilter,
  Get,
  type GuardFn,
  type HttpApplication,
  HttpConfigError,
  KneadFactory,
  MemoryLogger,
  MIN_BUN_VERSION,
  type Middleware,
  type MiddlewareFn,
  ModuleMiddleware,
  NotFoundException,
  originAllowed,
  Post,
  redirectToHttps,
  UseFilters,
  UseGuards,
  UseMiddleware,
  WS_DEFAULTS,
  WsRegistry,
  withHeaders,
} from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import * as v from 'valibot';
import {
  AccountNotFoundError,
  ErrorTracker,
  AppModule as FiltersApp,
} from '../snippets/http-pipeline/filters.js';
import {
  auditModuleGuard,
  bearerOrUpgrade,
  AppModule as GuardsApp,
} from '../snippets/http-pipeline/guards.js';
import {
  MaintenanceSwitch,
  AppModule as MiddlewareApp,
} from '../snippets/http-pipeline/middleware.js';
import { bootstrap, productionListen } from '../snippets/http-pipeline/server.js';
import { ChatGateway, ChatModule, ChatTickets } from '../snippets/http-pipeline/websockets.js';

let moduleRef: TestingModule | undefined;
let rawApp: HttpApplication | undefined;

afterEach(async () => {
  await moduleRef?.close();
  await rawApp?.close();
  moduleRef = undefined;
  rawApp = undefined;
});

async function serve(
  imports: Parameters<typeof Test.createModule>[0],
  options: { development?: boolean; setup?: (app: HttpApplication) => void } = {},
  listen: Parameters<TestingModule['createApp']>[0] = {},
): Promise<TestApp> {
  moduleRef = await Test.createModule(imports).compile({
    development: options.development ?? false,
  });
  options.setup?.(moduleRef.app);
  return moduleRef.createApp(listen);
}

const UPGRADE = [
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
];

/** Sends a raw HTTP/1.1 GET and resolves with the response head and body text. */
function raw(port: number, path: string, headers: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([`GET ${path} HTTP/1.1`, ...headers, '', ''].join('\r\n'));
    });
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      const head = response.indexOf('\r\n\r\n');
      if (head === -1) return;
      if (response.startsWith('HTTP/1.1 101')) return socket.end();
      const length = /content-length: (\d+)/i.exec(response)?.[1];
      if (length === undefined || response.length - head - 4 >= Number(length)) socket.end();
    });
    socket.on('close', () => resolve(response));
    socket.on('error', reject);
  });
}

function wsUrl(app: TestApp, path: string): string {
  const url = new URL(path, app.url);
  url.protocol = 'ws:';
  return url.toString();
}

function open(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('socket error'));
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
}

describe('pipeline order', () => {
  test('middleware, guards, validation, authorize, handler, in that order', async () => {
    const trace: string[] = [];
    const mw =
      (name: string): MiddlewareFn =>
      async (_ctx, next) => {
        trace.push(`${name}:in`);
        const res = await next();
        trace.push(`${name}:out`);
        return res;
      };
    const guard =
      (name: string): GuardFn =>
      () => {
        trace.push(name);
        return true;
      };
    const query = v.pipe(
      v.record(v.string(), v.string()),
      v.transform((value) => {
        trace.push('validate');
        return value;
      }),
    );

    @Controller('/t', { middleware: [mw('controller-option')], guards: [guard('controller')] })
    @UseMiddleware(mw('controller-decorator'))
    class C {
      @Get('/', {
        middleware: [mw('route-option')],
        guards: [guard('route')],
        authorize: [guard('authorize')],
        query,
      })
      @UseMiddleware(mw('route-decorator'))
      handler() {
        trace.push('handler');
        return 'ok';
      }
    }

    @ModuleMiddleware(mw('module'))
    @Module({
      controllers: [C],
      providers: [
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useValue: { middleware: mw('p900'), priority: 900 },
        },
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useValue: { middleware: mw('p1100'), priority: 1100 },
        },
        { provide: APP_MIDDLEWARE, multi: true, useValue: { middleware: mw('p0-provider') } },
        { provide: APP_GUARD, multi: true, useValue: guard('global-provider') },
      ],
    })
    class M {}

    const app = await serve(
      { imports: [M] },
      {
        setup: (a) => {
          a.useGlobalMiddleware(mw('p0-imperative'));
          a.useGlobalMiddleware(mw('p1000'), 1000);
          a.useGlobalGuards(guard('global-imperative'));
        },
      },
    );
    expect((await app.request('GET', '/t')).status).toBe(200);
    expect(trace).toEqual([
      'p1100:in',
      'p1000:in',
      'p900:in',
      'p0-provider:in',
      'p0-imperative:in',
      'module:in',
      'controller-option:in',
      'controller-decorator:in',
      'route-option:in',
      'route-decorator:in',
      'global-provider',
      'global-imperative',
      'controller',
      'route',
      'validate',
      'authorize',
      'handler',
      'route-decorator:out',
      'route-option:out',
      'controller-decorator:out',
      'controller-option:out',
      'module:out',
      'p0-imperative:out',
      'p0-provider:out',
      'p900:out',
      'p1000:out',
      'p1100:out',
    ]);
  });

  test('a guard failure skips validation and the handler; a validation failure skips authorize', async () => {
    const trace: string[] = [];
    const schema = v.pipe(
      v.unknown(),
      v.check(() => {
        trace.push('validate');
        return false;
      }, 'bad'),
    );
    @Controller()
    class C {
      @Get('/denied', { guards: [() => false], query: schema })
      denied() {
        trace.push('handler');
      }
      @Get('/invalid', {
        query: schema,
        authorize: [
          () => {
            trace.push('authorize');
            return true;
          },
        ],
      })
      invalid() {
        trace.push('handler');
      }
    }
    const app = await serve({ controllers: [C] });
    expect((await app.request('GET', '/denied')).status).toBe(403);
    expect(trace).toEqual([]);
    expect((await app.request('GET', '/invalid')).status).toBe(400);
    expect(trace).toEqual(['validate']);
  });
});

describe('middleware', () => {
  test('the snippet module: class, function, route and module middleware', async () => {
    const app = await serve({ imports: [MiddlewareApp] });
    const daily = await app.request('GET', '/reports/daily');
    expect(daily.status).toBe(200);
    expect(daily.headers.get('server-timing')).toMatch(/^app;dur=\d+\.\d$/);
    expect(daily.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(daily.headers.get('cache-control')).toBeNull();
    const live = await app.request('GET', '/reports/live');
    expect(live.headers.get('cache-control')).toBe('no-store');
  });

  test('short-circuiting with a Response skips everything inside', async () => {
    const app = await serve({ imports: [MiddlewareApp] });
    moduleRef!.get(MaintenanceSwitch).enabled = true;
    const res = await app.request('GET', '/reports/daily');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(await res.text()).toBe('Down for maintenance');
    // Module and controller middleware are inside MaintenanceMode, so they never ran.
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  test('a middleware throw becomes a Response that outer middleware still decorates', async () => {
    const app = await serve({ imports: [MiddlewareApp] });
    const res = await app.request('POST', '/reports/export', {
      body: 'a,b',
      headers: { 'content-type': 'text/csv' },
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Unsupported Media Type',
      status: 415,
      detail: 'Send application/json',
      instance: '/reports/export',
    });
    expect(res.headers.get('x-request-id')).not.toBeNull();
    expect(res.headers.get('server-timing')).not.toBeNull();
    const ok = await app.request('POST', '/reports/export', { json: { day: '2026-10-01' } });
    expect(ok.status).toBe(200);
  });

  test('await next() resolves to the error response instead of throwing', async () => {
    const seen: number[] = [];
    const outer: MiddlewareFn = async (_ctx, next) => {
      const res = await next();
      seen.push(res.status);
      return res;
    };
    @Controller('', { middleware: [outer] })
    class C {
      @Get('/boom')
      boom(): never {
        throw new NotFoundException('gone');
      }
    }
    const app = await serve({ controllers: [C] });
    expect((await app.request('GET', '/boom')).status).toBe(404);
    expect(seen).toEqual([404]);
  });

  test('not returning a Response, or calling next() twice, is a 500', async () => {
    const noResponse = { use: () => 'nope' } as unknown as Middleware;
    const twice: MiddlewareFn = async (_ctx, next) => {
      await next();
      return next();
    };
    @Controller()
    class C {
      @Get('/a', { middleware: [noResponse] })
      a() {
        return 'a';
      }
      @Get('/b', { middleware: [twice] })
      b() {
        return 'b';
      }
    }
    const logger = new MemoryLogger();
    moduleRef = await Test.createModule({ controllers: [C] }).compile({
      development: true,
      logger,
    });
    const app = await moduleRef.createApp();
    const a = await app.request('GET', '/a');
    expect(a.status).toBe(500);
    expect(((await a.json()) as { detail: string }).detail).toBe(
      '(anonymous) did not return a Response',
    );
    const b = await app.request('GET', '/b');
    expect(b.status).toBe(500);
    expect(((await b.json()) as { detail: string }).detail).toBe(
      'next() called multiple times in (anonymous)',
    );
  });

  test('unmatched requests run global middleware only', async () => {
    const tag: MiddlewareFn = async (_ctx, next) => withHeaders(await next(), { 'x-global': '1' });
    const app = await serve(
      { imports: [MiddlewareApp] },
      {
        setup: (a) => a.useGlobalMiddleware(tag),
      },
    );
    const res = await app.request('GET', '/nowhere');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-global')).toBe('1');
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  test('useGlobalMiddleware after listen() is a configuration error', async () => {
    await serve({ imports: [MiddlewareApp] });
    expect(() => moduleRef!.app.useGlobalMiddleware(() => new Response())).toThrow(
      'useGlobalMiddleware() must be called before listen().',
    );
  });
});

describe('guards', () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  test('a throwing guard sets the status; false is a bare 403', async () => {
    const app = await serve({ imports: [GuardsApp] });
    const anonymous = await app.request('GET', '/admin/stats');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(await anonymous.json()).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Sign in first',
      instance: '/admin/stats',
    });
    const bob = await app.request('GET', '/admin/stats', { headers: auth('token-bob') });
    expect(bob.status).toBe(403);
    expect(bob.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(bob.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await bob.text()).toBe(
      '{"type":"about:blank","title":"Forbidden","status":403,"instance":"/admin/stats"}',
    );
    const ada = await app.request('GET', '/admin/stats', { headers: auth('token-ada') });
    expect(ada.status).toBe(200);
    // No @Roles: the roles guard passes any signed-in user.
    const me = await app.request('GET', '/admin/me', { headers: auth('token-bob') });
    expect(await me.json()).toEqual({ id: 'bob' });
  });

  test('global guards run first', async () => {
    const app = await serve({ imports: [GuardsApp] });
    const res = await app.request('GET', '/admin/stats', {
      headers: { ...auth('token-ada'), 'user-agent': 'sqlmap/1.8' },
    });
    expect(res.status).toBe(403);
  });

  test('authorize guards see the validated body', async () => {
    const app = await serve({ imports: [GuardsApp] });
    const own = await app.request('POST', '/admin/transfers', {
      headers: auth('token-ada'),
      json: { account: '  ADA ', amount: 5 },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ from: 'ada', amount: 5 });
    const other = await app.request('POST', '/admin/transfers', {
      headers: auth('token-ada'),
      json: { account: 'bob', amount: 5 },
    });
    expect(other.status).toBe(403);
    const invalid = await app.request('POST', '/admin/transfers', {
      headers: auth('token-ada'),
      json: { account: 'ada', amount: 0 },
    });
    expect(invalid.status).toBe(400);
  });

  test('only true passes', async () => {
    const truthy = (() => 'yes') as unknown as GuardFn;
    @Controller()
    class C {
      @Get('/x', { guards: [truthy] })
      x() {
        return 'x';
      }
    }
    const app = await serve({ controllers: [C] });
    expect((await app.request('GET', '/x')).status).toBe(403);
  });

  test('an arrow-function canActivate field is rejected at listen()', async () => {
    class FieldGuard {
      canActivate = () => true;
    }
    @Controller()
    @UseGuards(FieldGuard)
    class Reports {
      @Get('/r')
      r() {
        return 'r';
      }
    }
    moduleRef = await Test.createModule({ controllers: [Reports] }).compile();
    const error = await moduleRef.createApp().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpConfigError);
    expect((error as Error).message).toBe(
      'Invalid guard in the guards of Reports: class FieldGuard. A guard is an object with ' +
        'canActivate(), a function, or a class with a canActivate() method (not an arrow-function field).',
    );
  });

  test('assertGuardRef names the place in its error', () => {
    expect(() => auditModuleGuard({ guard: undefined as never })).toThrow(
      'Invalid guard in AuditModule.forRoot({ guard }): undefined (often a circular import).',
    );
    expect(auditModuleGuard({ guard: () => true })).toBeFunction();
  });
});

describe('exception filters', () => {
  test('a @Catch filter maps a domain error; route filters come before controller filters', async () => {
    const app = await serve({ imports: [FiltersApp] });
    const missing = await app.request('GET', '/accounts/acc_2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Account acc_2 does not exist',
      instance: '/accounts/acc_2',
    });
    const statement = await app.request('GET', '/accounts/acc_1/statement');
    expect(statement.status).toBe(503);
    expect(statement.headers.get('retry-after')).toBe('30');
    expect((await app.request('GET', '/accounts/acc_1')).status).toBe(200);
    // Handled before the global filter: nothing reported.
    expect(moduleRef!.get(ErrorTracker).reported).toEqual([]);
  });

  test('a declining filter passes the error on to the default response', async () => {
    @Controller()
    class C {
      @Get('/crash')
      crash(): never {
        throw new Error('database is down');
      }
      @Get('/missing')
      missing(): never {
        throw new NotFoundException();
      }
    }
    const app = await serve({ imports: [FiltersApp], controllers: [C] });
    const res = await app.request('GET', '/crash');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/crash',
      correlationId: expect.any(String),
    });
    expect((await app.request('GET', '/missing')).status).toBe(404);
    const reported = moduleRef!.get(ErrorTracker).reported;
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe('database is down');
  });

  test('a filter that throws or returns a non-Response falls back to the default for the original error', async () => {
    class Throws implements ExceptionFilter {
      catch(): Response {
        throw new NotFoundException('converted');
      }
    }
    const notResponse = { catch: () => ({ status: 404 }) } as unknown as ExceptionFilter;
    const later = { catch: () => new Response('later') };
    @Controller()
    @UseFilters(later)
    class C {
      @Get('/throws', { filters: [Throws] })
      throws(): never {
        throw new AccountNotFoundError('acc_9');
      }
      @Get('/object', { filters: [notResponse] })
      object(): never {
        throw new AccountNotFoundError('acc_9');
      }
    }
    const logger = new MemoryLogger();
    moduleRef = await Test.createModule({ controllers: [C] }).compile({
      development: false,
      logger,
    });
    const app = await moduleRef.createApp();
    const thrown = await app.request('GET', '/throws');
    expect(thrown.status).toBe(500);
    const object = await app.request('GET', '/object');
    expect(object.status).toBe(500);
    const messages = logger.entries.filter((e) => e.level === 'error').map((e) => e.message);
    expect(
      messages.some((m) => m.startsWith('Exception filter Throws threw (correlation id ')),
    ).toBe(true);
    expect(messages).toContain('Exception filter (anonymous) did not return a Response');
  });

  test('@Catch matches subclasses with instanceof', async () => {
    class Base extends Error {}
    class Derived extends Base {}
    @Catch(Base)
    class BaseFilter implements ExceptionFilter<Base> {
      catch(): Response {
        return new Response('handled', { status: 409 });
      }
    }
    @Controller()
    class C {
      @Get('/d', { filters: [BaseFilter] })
      d(): never {
        throw new Derived();
      }
    }
    const app = await serve({ controllers: [C] });
    expect((await app.request('GET', '/d')).status).toBe(409);
  });
});

describe('server', () => {
  test('bootstrap(): allowedHosts answers other hosts with 421; defaultCacheControl applies', async () => {
    rawApp = await bootstrap({ ...productionListen, port: 0, hostname: '127.0.0.1' });
    const port = rawApp.port;
    const ok = await raw(port, '/health', ['Host: api.example.com', 'Connection: close']);
    expect(ok.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(ok.toLowerCase()).toContain('cache-control: no-store');
    const other = await raw(port, '/health', ['Host: evil.example', 'Connection: close']);
    expect(other.split('\r\n')[0]).toBe('HTTP/1.1 421 Misdirected Request');
    expect(
      other.endsWith(
        '{"type":"about:blank","title":"Misdirected Request","status":421,"detail":"This server does not serve the requested host."}',
      ),
    ).toBe(true);
  });

  test('development defaults allowedHosts to loopback names', async () => {
    @Controller()
    class C {
      @Get('/')
      root() {
        return 'ok';
      }
    }
    @Module({ controllers: [C] })
    class M {}
    rawApp = await KneadFactory.create(M, { logger: new MemoryLogger(), development: true });
    await rawApp.listen({ port: 0, hostname: '127.0.0.1' });
    const port = rawApp.port;
    for (const host of ['localhost', `127.0.0.1:${port}`, '[::1]']) {
      expect((await raw(port, '/', [`Host: ${host}`, 'Connection: close'])).split('\r\n')[0]).toBe(
        'HTTP/1.1 200 OK',
      );
    }
    expect(
      (await raw(port, '/', ['Host: rebind.example', 'Connection: close'])).split('\r\n')[0],
    ).toBe('HTTP/1.1 421 Misdirected Request');
  });

  test('maxRequestBodySize defaults to 1 MiB', async () => {
    @Controller()
    class C {
      @Post('/upload')
      async upload(ctx: Ctx) {
        return { length: String(await ctx.json()).length };
      }
    }
    const app = await serve({ controllers: [C] });
    const headers = { 'content-type': 'text/plain' };
    const fits = await app.request('POST', '/upload', { headers, body: 'x'.repeat(1024 * 1024) });
    expect(await fits.json()).toEqual({ length: 1024 * 1024 });
    const big = await app.request('POST', '/upload', {
      headers,
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
  });

  test('trustProxy decides whether X-Forwarded-For and X-Forwarded-Proto count', async () => {
    @Controller()
    class C {
      @Get('/whoami')
      whoami(ctx: Ctx) {
        return { ip: ctx.ip, secure: ctx.secure };
      }
    }
    const headers = { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' };
    const off = await serve({ controllers: [C] });
    expect(await (await off.request('GET', '/whoami', { headers })).json()).toEqual({
      ip: '127.0.0.1',
      secure: false,
    });
    expect(
      moduleRef!.logs.some(
        (e) => e.level === 'warn' && e.message.startsWith('A request carried X-Forwarded-*'),
      ),
    ).toBe(true);
    await moduleRef!.close();
    const on = await serve({ controllers: [C] }, {}, { trustProxy: ['127.0.0.1/32'] });
    expect(await (await on.request('GET', '/whoami', { headers })).json()).toEqual({
      ip: '203.0.113.7',
      secure: true,
    });
  });

  test('redirectToHttps', () => {
    const req = new Request('http://example.com/a?b=1', { headers: { host: 'example.com:80' } });
    const res = redirectToHttps(req, 443);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://example.com/a?b=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(redirectToHttps(req, 8443, 'api.example.com').headers.get('location')).toBe(
      'https://api.example.com:8443/a?b=1',
    );
    expect(redirectToHttps(req, 443, 'api.example.com:9443').headers.get('location')).toBe(
      'https://api.example.com:9443/a?b=1',
    );
    expect(() => redirectToHttps(req, 443, 'bad host')).toThrow(HttpConfigError);
  });

  test('redirectHttp requires tls; listen() twice is rejected', async () => {
    @Module({})
    class Empty {}
    rawApp = await KneadFactory.create(Empty, { logger: new MemoryLogger() });
    await expect(rawApp.listen({ port: 0, redirectHttp: { port: 0 } })).rejects.toThrow(
      'redirectHttp requires tls.',
    );
    await rawApp.listen({ port: 0, hostname: '127.0.0.1' });
    await expect(rawApp.listen({ port: 0 })).rejects.toThrow('listen() was already called.');
  });

  test('checkBunVersion and compareVersions', () => {
    expect(MIN_BUN_VERSION).toBe('1.4.3');
    expect(compareVersions('1.4.2', '1.4.3')).toBeLessThan(0);
    expect(compareVersions('1.4.3-canary.1', '1.4.3')).toBe(0);
    expect(checkBunVersion(new MemoryLogger(), '1.5.0')).toBe(true);
    expect(checkBunVersion(new MemoryLogger(), '1.4.2')).toBe(false);
  });
});

describe('websockets', () => {
  test('WS_DEFAULTS', () => {
    expect(WS_DEFAULTS).toEqual({
      maxPayloadLength: 262144,
      backpressureLimit: 1048576,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      maxConnectionsPerIp: 100,
      ipv6Subnet: 64,
      messageRate: { limit: 100, windowMs: 10_000 },
      maxPendingRevocations: 10_000,
    });
  });

  test('originAllowed', () => {
    expect(originAllowed(null, 'api.example.com', true)).toBe(true);
    expect(originAllowed('https://api.example.com', 'api.example.com:443', true)).toBe(true);
    expect(originAllowed('http://api.example.com', 'api.example.com', true)).toBe(false);
    expect(originAllowed('null', 'api.example.com', true)).toBe(false);
    expect(originAllowed('https://app.example.com', 'api.example.com', true)).toBe(false);
    expect(
      originAllowed('https://app.example.com', 'api.example.com', true, [
        'https://app.example.com',
      ]),
    ).toBe(true);
    expect(originAllowed('https://anything.test', 'api.example.com', true, '*')).toBe(true);
  });

  test('chat: tickets, broadcast and sign-out', async () => {
    const app = await serve({ imports: [ChatModule] });
    const tickets = moduleRef!.get(ChatTickets);
    const ada = await open(wsUrl(app, `/chat?ticket=${tickets.issue('ada')}`));
    const bob = await open(wsUrl(app, `/chat?ticket=${tickets.issue('bob')}`));
    await Bun.sleep(20);
    const received = new Promise<string>((resolve) => {
      bob.onmessage = (e) => resolve(String(e.data));
    });
    ada.send('hello');
    expect(JSON.parse(await received)).toEqual({ from: 'ada', text: 'hello' });
    const adaClosed = closed(ada);
    expect(moduleRef!.get(ChatGateway).signOut('ada')).toBe(1);
    expect(await adaClosed).toEqual({ code: 1008, reason: 'Connection revoked' });
    bob.close();
  });

  test('a refused upgrade is 403; a cross-origin one is 403 before upgrade() runs', async () => {
    const app = await serve({ imports: [ChatModule] });
    const port = Number(app.url.port);
    const host = `Host: 127.0.0.1:${port}`;
    const bad = await raw(port, '/chat?ticket=nope', [host, ...UPGRADE]);
    expect(bad.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(bad).toContain('"detail":"WebSocket upgrade rejected"');
    const ticket = moduleRef!.get(ChatTickets).issue('ada');
    const evil = await raw(port, `/chat?ticket=${ticket}`, [
      host,
      'Origin: https://evil.example',
      ...UPGRADE,
    ]);
    expect(evil.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(evil).toContain('"detail":"Cross-origin WebSocket connections are not allowed."');
    // upgrade() did not run, so the ticket is still valid.
    const listed = await raw(port, `/chat?ticket=${ticket}`, [
      host,
      'Origin: https://app.example.com',
      ...UPGRADE,
    ]);
    expect(listed.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    const same = await raw(port, `/chat?ticket=${moduleRef!.get(ChatTickets).issue('bob')}`, [
      host,
      `Origin: http://127.0.0.1:${port}`,
      ...UPGRADE,
    ]);
    expect(same.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
  });

  test('the message rate closes a socket with 1008', async () => {
    const app = await serve({ imports: [ChatModule] });
    const socket = await open(
      wsUrl(app, `/chat?ticket=${moduleRef!.get(ChatTickets).issue('ada')}`),
    );
    const done = closed(socket);
    for (let i = 0; i < 21; i++) socket.send(`m${i}`);
    expect(await done).toEqual({ code: 1008, reason: 'Message rate exceeded' });
  });

  test('maxConnectionsPerIp answers further upgrades with 429', async () => {
    const app = await serve(
      { imports: [ChatModule] },
      {},
      { websocket: { maxConnectionsPerIp: 1 } },
    );
    const tickets = moduleRef!.get(ChatTickets);
    const first = await open(wsUrl(app, `/chat?ticket=${tickets.issue('ada')}`));
    const port = Number(app.url.port);
    const second = await raw(port, `/chat?ticket=${tickets.issue('ada')}`, [
      `Host: 127.0.0.1:${port}`,
      ...UPGRADE,
    ]);
    expect(second.split('\r\n')[0]).toBe('HTTP/1.1 429 Too Many Requests');
    expect(second).toContain('"detail":"Too many WebSocket connections from this address."');
    first.close();
  });

  test('a global guard sees upgrades through ctx.upgrade', async () => {
    @Controller()
    class C {
      @Get('/data')
      data() {
        return 'data';
      }
    }
    @Module({
      imports: [ChatModule],
      controllers: [C],
      providers: [{ provide: APP_GUARD, multi: true, useValue: bearerOrUpgrade }],
    })
    class M {}
    const app = await serve({ imports: [M] });
    expect((await app.request('GET', '/data')).status).toBe(403);
    expect(
      (await app.request('GET', '/data', { headers: { authorization: 'Bearer t' } })).status,
    ).toBe(200);
    const socket = await open(
      wsUrl(app, `/chat?ticket=${moduleRef!.get(ChatTickets).issue('ada')}`),
    );
    socket.close();
  });

  test('registering after listen() is a configuration error', async () => {
    await serve({ imports: [ChatModule] });
    expect(() => moduleRef!.get(WsRegistry).register('/late', { upgrade: () => ({}) })).toThrow(
      'WebSocket endpoint /late was registered after listen().',
    );
  });

  test('headers that middleware adds to an upgrade are not sent with the 101', async () => {
    const tag: MiddlewareFn = async (_ctx, next) => withHeaders(await next(), { 'x-tag': '1' });
    const app = await serve(
      { imports: [ChatModule] },
      { setup: (a) => a.useGlobalMiddleware(tag) },
    );
    const port = Number(app.url.port);
    const res = await raw(port, `/chat?ticket=${moduleRef!.get(ChatTickets).issue('ada')}`, [
      `Host: 127.0.0.1:${port}`,
      ...UPGRADE,
    ]);
    expect(res.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(res.toLowerCase()).not.toContain('x-tag');
  });

  test('headers set on ctx.res before next() are sent with the 101', async () => {
    const cookie: MiddlewareFn = (ctx, next) => {
      ctx.res.headers.set('set-cookie', 'seen=1; HttpOnly');
      return next();
    };
    const app = await serve(
      { imports: [ChatModule] },
      { setup: (a) => a.useGlobalMiddleware(cookie) },
    );
    const port = Number(app.url.port);
    const res = await raw(port, `/chat?ticket=${moduleRef!.get(ChatTickets).issue('ada')}`, [
      `Host: 127.0.0.1:${port}`,
      ...UPGRADE,
    ]);
    expect(res.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(res.toLowerCase()).toContain('set-cookie: seen=1; httponly');
  });
});
