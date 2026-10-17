import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module } from '@knead-js/core';
import type { HttpApplication } from '../src/application.js';
import { Controller, createRouteDecorator, Get, Post, UseGuards } from '../src/decorators.js';
import {
  BadRequestException,
  HttpConfigError,
  ServiceUnavailableException,
} from '../src/exceptions.js';
import type { MemoryLogger } from '../src/logger.js';
import { HTTP_DEVELOPMENT } from '../src/tokens.js';
import type { Ctx } from '../src/types.js';
import { WsRegistry } from '../src/ws.js';
import { makeCtx, start } from './helpers.js';

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

@Controller('/echo')
class Echo {
  @Post('/')
  async echo(ctx: Ctx) {
    const text = await ctx.req.text();
    return { length: text.length };
  }
}

@Module({ controllers: [Echo] })
class EchoModule {}

describe('request body limit', () => {
  test('bodies over the 1 MiB default are rejected with 413', async () => {
    app = await start(EchoModule);
    const url = new URL('/echo', app.url);
    const ok = await fetch(url, { method: 'POST', body: 'x'.repeat(1024 * 1024) });
    expect(ok.status).toBe(200);
    const big = await fetch(url, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  test('maxRequestBodySize is configurable', async () => {
    app = await start(EchoModule, { maxRequestBodySize: 2 * 1024 * 1024 });
    const res = await fetch(new URL('/echo', app.url), {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(200);
  });
});

describe('guards', () => {
  test('only a strict true passes; truthy values are denied', async () => {
    const results: unknown[] = [1, 'yes', {}, [], Promise.resolve('true')];
    let next: unknown;
    @Controller('/guarded')
    class Guarded {
      @Get('/')
      @UseGuards(() => next as boolean)
      get() {
        return 'ok';
      }
    }
    @Module({ controllers: [Guarded] })
    class M {}
    app = await start(M);
    const url = new URL('/guarded', app.url);
    for (const value of results) {
      next = value;
      expect((await fetch(url)).status).toBe(403);
    }
    next = true;
    expect((await fetch(url)).status).toBe(200);
  });

  test('ctx.meta aliases the route metadata, and is an empty frozen object without a route', async () => {
    const Roles = createRouteDecorator<string[]>('roles');
    let seen: unknown;
    @Controller('/meta')
    class Meta {
      @Get('/')
      @Roles(['admin'])
      get(ctx: Ctx) {
        seen = ctx.meta;
        return 'ok';
      }
    }
    @Module({ controllers: [Meta] })
    class M {}
    app = await start(M);
    await fetch(new URL('/meta', app.url));
    expect(seen).toEqual({ roles: ['admin'] });
    const bare = makeCtx('/nowhere');
    expect(bare.meta).toEqual({});
    expect(Object.isFrozen(bare.meta)).toBe(true);
  });
});

describe('5xx problem responses', () => {
  @Controller('/fail')
  class Fail {
    @Get('/5xx')
    server() {
      throw new ServiceUnavailableException('database at 10.0.0.7 is down', {
        extensions: { host: '10.0.0.7' },
        headers: { 'retry-after': '5' },
      });
    }
    @Get('/4xx')
    client() {
      throw new BadRequestException('bad input', { extensions: { field: 'name' } });
    }
  }
  @Module({ controllers: [Fail] })
  class M {}

  test('production strips detail and extensions from 5xx, keeping headers', async () => {
    app = await start(M);
    const res = await fetch(new URL('/fail/5xx', app.url));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { correlationId: string };
    expect(body as unknown).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      instance: '/fail/5xx',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const logged = (app.logger as MemoryLogger).entries.find((e) => e.level === 'error')!;
    expect(logged.message).toContain(body.correlationId);
    expect(logged.message).toContain('ServiceUnavailableException: database at 10.0.0.7 is down');
    expect(logged.meta).toEqual([]);
    const client = await fetch(new URL('/fail/4xx', app.url));
    expect(await client.json()).toMatchObject({ detail: 'bad input', field: 'name' });
  });

  test('development keeps 5xx detail and extensions', async () => {
    app = await start(M, {}, { development: true });
    const res = await fetch(new URL('/fail/5xx', app.url));
    expect(await res.json()).toMatchObject({
      detail: 'database at 10.0.0.7 is down',
      host: '10.0.0.7',
    });
  });
});

describe('forwarded headers without trustProxy', () => {
  test('one warning is logged the first time X-Forwarded-* arrives untrusted', async () => {
    app = await start(EchoModule);
    const url = new URL('/echo', app.url);
    const logger = app.logger as MemoryLogger;
    await fetch(url, { method: 'POST' });
    expect(logger.entries.filter((e) => e.level === 'warn')).toEqual([]);
    for (let i = 0; i < 3; i++) {
      await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } });
      await fetch(new URL('/missing', app.url), { headers: { 'x-forwarded-proto': 'https' } });
    }
    const warnings = logger.entries.filter((e) => e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('trustProxy');
  });

  test('no warning when trustProxy is configured', async () => {
    app = await start(EchoModule, { trustProxy: 1 });
    await fetch(new URL('/echo', app.url), {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect((app.logger as MemoryLogger).entries.filter((e) => e.level === 'warn')).toEqual([]);
  });
});

describe('route wildcards', () => {
  test('more than one * in a route is a configuration error', async () => {
    @Controller('/files')
    class Files {
      @Get('/*/x/*')
      get() {
        return 'ok';
      }
    }
    @Module({ controllers: [Files] })
    class M {}
    await expect(start(M)).rejects.toThrow(HttpConfigError);
  });

  test.each(['/a/*/b', '/a*', '/a/b*c'])(
    'a * that is not the whole last segment (%s) is a configuration error, since Bun never matches it',
    async (path) => {
      @Controller('/files')
      class Files {
        @Get(path)
        get() {
          return 'ok';
        }
      }
      @Module({ controllers: [Files] })
      class M {}
      await expect(start(M)).rejects.toThrow(
        `Route /files${path} has a "*" that is not the whole last segment (Files.get); Bun only matches a trailing "/*".`,
      );
    },
  );

  test('a single trailing * is fine', async () => {
    @Controller('/files')
    class Files {
      @Get('/*')
      get() {
        return 'ok';
      }
    }
    @Module({ controllers: [Files] })
    class M {}
    app = await start(M);
    expect((await fetch(new URL('/files/a/b', app.url))).status).toBe(200);
  });
});

describe('development mode', () => {
  class Reader {
    readonly development = inject(HTTP_DEVELOPMENT);
  }
  @Module({ providers: [Reader], exports: [Reader] })
  class M {}

  test('HTTP_DEVELOPMENT exposes the resolved development flag to every module', async () => {
    app = await start(M, {}, { development: true });
    expect(app.get(HTTP_DEVELOPMENT)).toBe(true);
    expect(app.get(Reader).development).toBe(true);
    await app.close();
    app = await start(M, {}, { development: false });
    expect(app.get(Reader).development).toBe(false);
  });

  const devWarnings = (a: HttpApplication) =>
    (a.logger as MemoryLogger).entries.filter(
      (e) => e.level === 'warn' && e.message.includes('development'),
    );

  test('listening on a non-loopback hostname in development logs a warning', async () => {
    app = await start(M, { hostname: '0.0.0.0' }, { development: true });
    expect(devWarnings(app)).toHaveLength(1);
  });

  test('loopback hostnames, or production, do not warn', async () => {
    for (const hostname of ['127.0.0.1', 'localhost', '::1']) {
      app = await start(M, { hostname }, { development: true });
      expect(devWarnings(app)).toEqual([]);
      await app.close();
    }
    app = await start(M, { hostname: '0.0.0.0' }, { development: false });
    expect(devWarnings(app)).toEqual([]);
  });
});

describe('listen({ maxParams })', () => {
  @Controller('/params')
  class Params {
    @Get('/')
    query(ctx: Ctx) {
      return { keys: Object.keys(ctx.query) };
    }
    @Post('/')
    async form(ctx: Ctx) {
      return { keys: Object.keys((await ctx.json()) as object) };
    }
  }
  @Module({ controllers: [Params] })
  class ParamsModule {}

  test('caps query parameters (400) and form fields (413)', async () => {
    app = await start(ParamsModule, { maxParams: 2 });
    expect((await fetch(new URL('/params?a=1&b=2', app.url))).status).toBe(200);
    expect((await fetch(new URL('/params?a=1&b=2&c=3', app.url))).status).toBe(400);
    const res = await fetch(new URL('/params', app.url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2&c=3',
    });
    expect(res.status).toBe(413);
  });

  test('an invalid maxParams is a configuration error', async () => {
    for (const maxParams of [0, -1, 1.5]) {
      await expect(start(ParamsModule, { maxParams })).rejects.toThrow(HttpConfigError);
    }
  });
});

describe('listen({ validation: { redactIssueMessages } })', () => {
  const echo = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => ({
        issues: [{ message: `bad ${JSON.stringify(value)}`, path: ['name'] }],
      }),
    },
  };
  @Controller('/v')
  class V {
    @Post('/', { body: echo }) create() {
      return 'ok';
    }
  }
  @Module({ controllers: [V] })
  class VModule {}

  test('the 400 does not echo the body', async () => {
    app = await start(VModule, { validation: { redactIssueMessages: true } });
    const res = await fetch(new URL('/v', app.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"s3cret"}',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('s3cret');
    expect(text).toContain('Invalid value');
  });
});

describe('listen({ defaultCacheControl })', () => {
  @Controller('/c')
  class C {
    @Get('/plain') plain() {
      return { a: 1 };
    }
    @Get('/own') own(ctx: Ctx) {
      ctx.res.headers.set('cache-control', 'public, max-age=60');
      return 'cached';
    }
    @Get('/raw') raw() {
      return new Response('raw', { headers: { 'cache-control': 'max-age=5' } });
    }
  }
  @Module({ controllers: [C] })
  class CModule {}

  test('applies to responses without Cache-Control, including errors and 404s', async () => {
    app = await start(CModule, { defaultCacheControl: 'no-store' });
    const get = async (path: string) =>
      (await fetch(new URL(path, app!.url))).headers.get('cache-control');
    expect(await get('/c/plain')).toBe('no-store');
    expect(await get('/c/own')).toBe('public, max-age=60');
    expect(await get('/c/raw')).toBe('max-age=5');
    expect(await get('/missing')).toBe('no-store');
  });

  test('off by default; invalid values are a configuration error', async () => {
    app = await start(CModule);
    expect((await fetch(new URL('/c/plain', app.url))).headers.get('cache-control')).toBeNull();
    await app.close();
    app = undefined;
    for (const defaultCacheControl of ['', 'no-store\r\nx: 1', 'no\0store', 'max-age=\u0100']) {
      await expect(start(CModule, { defaultCacheControl })).rejects.toThrow(HttpConfigError);
    }
  });
});

describe('defaultCacheControl on early answers', () => {
  test('421 misdirected and rejected WebSocket upgrades get it too', async () => {
    class Gateway {
      readonly ws = inject(WsRegistry);
      onModuleInit() {
        this.ws.register('/live', { upgrade: () => false });
      }
    }
    @Controller('/c')
    class C {
      @Get('/') get() {
        return 'ok';
      }
    }
    @Module({ controllers: [C], providers: [Gateway] })
    class M {}
    app = await start(M, { defaultCacheControl: 'no-store', allowedHosts: ['127.0.0.1'] });
    const misdirected = await fetch(new URL('/c', app.url), { headers: { host: 'evil.test' } });
    expect(misdirected.status).toBe(421);
    expect(misdirected.headers.get('cache-control')).toBe('no-store');
    const unknown = await fetch(new URL('/nope', app.url), { headers: { host: 'evil.test' } });
    expect(unknown.status).toBe(421);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    const upgrade = await fetch(new URL('/live', app.url), {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    expect(upgrade.status).toBe(403);
    expect(upgrade.headers.get('cache-control')).toBe('no-store');
  });
});

describe('route status is validated at listen()', () => {
  test('a status that is not an integer from 200 to 599 is a configuration error', async () => {
    for (const status of [199, 600, 101, 200.5, Number.NaN, '201' as unknown as number]) {
      @Controller('/s')
      class S {
        @Get('/', { status }) get() {
          return 'ok';
        }
      }
      @Module({ controllers: [S] })
      class M {}
      await expect(start(M)).rejects.toThrow(HttpConfigError);
    }
  });

  test('a 204 route that returns a value answers without a body', async () => {
    @Controller('/s')
    class S {
      @Get('/', { status: 204 }) get() {
        return { ignored: true };
      }
    }
    @Module({ controllers: [S] })
    class M {}
    app = await start(M);
    const res = await fetch(new URL('/s', app.url));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});

describe('guard references are validated at listen()', () => {
  class ArrowGuard {
    canActivate = () => true;
  }
  class ProtoGuard {
    canActivate() {
      return true;
    }
  }

  test('undefined, arrow-field classes and plain objects are an HttpConfigError naming the route', async () => {
    for (const bad of [undefined, ArrowGuard, {}, null, 42]) {
      @Controller('/g')
      class G {
        @Get('/', { guards: [bad as never] }) get() {
          return 'x';
        }
      }
      @Module({ controllers: [G] })
      class GM {}
      const failure = await start(GM).catch((e) => e);
      expect(failure).toBeInstanceOf(HttpConfigError);
      expect((failure as Error).message).toContain('G.get');
    }
  });

  test('controller guards name the controller; valid refs pass', async () => {
    @Controller('/c', { guards: [undefined as never] })
    class Ctrl {
      @Get('/') get() {
        return 'x';
      }
    }
    @Module({ controllers: [Ctrl] })
    class CM {}
    await expect(start(CM)).rejects.toThrow('the guards of Ctrl');
    @Controller('/ok', { guards: [ProtoGuard, () => true, { canActivate: () => true }] })
    class Ok {
      @Get('/') get() {
        return 'ok';
      }
    }
    @Module({ controllers: [Ok] })
    class OkModule {}
    app = await start(OkModule);
    expect((await fetch(new URL('/ok', app.url))).status).toBe(200);
  });
});

describe('route authorize guards run after validation', () => {
  /** Trims and lowercases `email`. */
  const canonicalEmail = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => {
        const email = (value as { email?: unknown } | undefined)?.email;
        return typeof email === 'string'
          ? { value: { email: email.trim().toLowerCase() } }
          : { issues: [{ message: 'email required', path: ['email'] }] };
      },
    },
  };
  const seenByGuard: unknown[] = [];
  const seenByAuthorize: unknown[] = [];

  @Controller('/admins')
  class Admins {
    @Post('/', {
      body: canonicalEmail,
      guards: [
        async (ctx: Ctx) => {
          seenByGuard.push(await ctx.json());
          return true;
        },
      ],
      authorize: [
        (ctx: Ctx) => {
          seenByAuthorize.push(ctx.body);
          return (ctx.body as { email: string }).email === 'admin@example.com';
        },
      ],
    })
    invite(ctx: Ctx) {
      return ctx.body;
    }
  }
  @Module({ controllers: [Admins] })
  class AdminsModule {}

  const post = (email: string) =>
    fetch(new URL('/admins', app!.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });

  test('authorize sees the canonical value; guards see the raw one', async () => {
    app = await start(AdminsModule);
    const res = await post('  ADMIN@Example.com ');
    expect(res.status).toBe(200);
    expect(seenByGuard).toEqual([{ email: '  ADMIN@Example.com ' }]);
    expect(seenByAuthorize).toEqual([{ email: 'admin@example.com' }]);
    expect((await post('eve@example.com')).status).toBe(403);
    // Invalid input is a 400 before authorize runs.
    seenByAuthorize.length = 0;
    const bad = await fetch(new URL('/admins', app.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
    expect(seenByAuthorize).toEqual([]);
  });
});
