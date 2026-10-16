import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import type { HttpApplication } from '../src/application.js';
import { Controller, Post } from '../src/decorators.js';
import type { Ctx } from '../src/types.js';
import { start } from './helpers.js';

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
