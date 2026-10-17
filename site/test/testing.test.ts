import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionToken, inject, LOGGER, Module, NoProviderError } from '@knead-js/core';
import { ConsoleLogger, Controller, type Ctx, Get, MemoryLogger, Post } from '@knead-js/http';
import { Test } from '@knead-js/testing';
import { CatalogModule, ProductsService } from '../snippets/testing/catalog.js';
import { tlsSuite } from '../snippets/testing/tls.test-suite.js';
import '../snippets/testing/catalog.test-suite.js';
import '../snippets/testing/graphql.test-suite.js';

let certDir: string;
let certificate: { cert: Bun.BunFile; key: Bun.BunFile };

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'knead-docs-tls-'));
  const key = join(certDir, 'key.pem');
  const cert = join(certDir, 'cert.pem');
  const result = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  certificate = { cert: Bun.file(cert), key: Bun.file(key) };
});
afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

describe('testing: TLS', () => {
  tlsSuite(() => certificate);
});

describe('testing: builder and module', () => {
  @Controller('/echo')
  class EchoController {
    @Get('/')
    query(ctx: Ctx) {
      return ctx.query;
    }
    @Post('/')
    async body(ctx: Ctx) {
      return { type: ctx.req.headers.get('content-type'), body: await ctx.json() };
    }
  }

  test('createApp listens on 127.0.0.1, a random port, and is created once', async () => {
    const mod = await Test.createModule({ controllers: [EchoController] }).compile();
    try {
      const app = await mod.createApp();
      expect(app.url.hostname).toBe('127.0.0.1');
      expect(Number(app.url.port)).toBeGreaterThan(0);
      expect(await mod.createApp({ port: 1 })).toBe(app);
      const res = await app.request('GET', '/echo', { query: { a: ['1', '2'], b: 'x' } });
      expect(await res.json()).toEqual({ a: ['1', '2'], b: 'x' });
      const json = await app.request('POST', '/echo', { json: { n: 1 } });
      expect(await json.json()).toEqual({ type: 'application/json', body: { n: 1 } });
      const custom = await app.request('POST', '/echo', {
        json: { n: 2 },
        headers: { 'content-type': 'application/merge-patch+json' },
      });
      expect(((await custom.json()) as { type: string }).type).toBe('application/merge-patch+json');
      const raw = await app.request('POST', '/echo', {
        body: 'a=1',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(await raw.json()).toEqual({
        type: 'application/x-www-form-urlencoded',
        body: { a: '1' },
      });
    } finally {
      await mod.close();
    }
  });

  test('compile without createApp starts no server', async () => {
    const mod = await Test.createModule({ imports: [CatalogModule] }).compile();
    expect(() => mod.app.server).toThrow('The application is not listening; call listen() first.');
    expect(mod.get(ProductsService)).toBeInstanceOf(ProductsService);
    await mod.close();
  });

  test('overriding a token that no module provides has no effect', async () => {
    const MISSING = new InjectionToken<string>('MISSING');
    const mod = await Test.createModule({ imports: [CatalogModule] })
      .overrideProvider(MISSING)
      .useValue('x')
      .compile();
    expect(() => mod.get(MISSING)).toThrow(NoProviderError);
    await mod.close();
  });

  test('overrides replace the provider in every module that registers it', async () => {
    const CLOCK = new InjectionToken<() => number>('CLOCK');
    class A {
      readonly now = inject(CLOCK);
    }
    class B {
      readonly now = inject(CLOCK);
    }
    @Module({ providers: [{ provide: CLOCK, useValue: () => 1 }, A], exports: [A] })
    class ModA {}
    @Module({ providers: [{ provide: CLOCK, useValue: () => 2 }, B], exports: [B] })
    class ModB {}
    const mod = await Test.createModule({ imports: [ModA, ModB] })
      .overrideProvider(CLOCK)
      .useValue(() => 0)
      .compile();
    expect(mod.get(A).now()).toBe(0);
    expect(mod.get(B).now()).toBe(0);
    await mod.close();
  });

  test('logs is empty for a logger that is not a MemoryLogger', async () => {
    const mod = await Test.createModule({}).compile({ logger: new ConsoleLogger() });
    expect(mod.logs).toEqual([]);
    await mod.close();
  });

  test('a LOGGER override wins over the testing logger', async () => {
    const mine = new MemoryLogger();
    class Svc {
      readonly log = inject(LOGGER);
    }
    const mod = await Test.createModule({ providers: [Svc] })
      .overrideProvider(LOGGER)
      .useValue(mine)
      .compile();
    mod.get(Svc).log.info('hello');
    expect(mine.entries).toHaveLength(1);
    expect(mod.logs).toEqual([]);
    await mod.close();
  });

  test('TestApp.close stops the server like TestingModule.close', async () => {
    const mod = await Test.createModule({ controllers: [EchoController] }).compile();
    const app = await mod.createApp();
    const url = app.url;
    await app.close();
    await expect(fetch(new URL('/echo', url))).rejects.toThrow();
    await mod.close();
  });
});
