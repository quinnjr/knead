import { afterEach, describe, expect, test } from 'bun:test';
import { inject, Module } from '@hpmws/core';
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
