import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import type { HttpApplication } from '../src/application.js';
import { Controller, createRouteDecorator, Get, Post, UseGuards } from '../src/decorators.js';
import { BadRequestException, ServiceUnavailableException } from '../src/exceptions.js';
import type { MemoryLogger } from '../src/logger.js';
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
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      instance: '/fail/5xx',
    });
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
