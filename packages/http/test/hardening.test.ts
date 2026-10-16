import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import type { HttpApplication } from '../src/application.js';
import { Controller, createRouteDecorator, Get, Post, UseGuards } from '../src/decorators.js';
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
