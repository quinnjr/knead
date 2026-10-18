import { afterEach, describe, expect, test } from 'bun:test';
import { Injectable, inject, LOGGER, Module } from '@knead-js/core';
import {
  Controller,
  type Ctx,
  Get,
  type Guard,
  type HttpApplication,
  MemoryLogger,
  type Middleware,
  Post,
  UseFilters,
  UseGuards,
  UseMiddleware,
} from '@knead-js/http';
import { Test, TestApp, type TestingModule } from '../src/index.js';

@Injectable()
class Greeter {
  greet(name: string) {
    return `hello ${name}`;
  }
}

class AuthGuard implements Guard {
  canActivate(ctx: Ctx) {
    return ctx.req.headers.get('authorization') === 'Bearer real';
  }
}

class StampMiddleware implements Middleware {
  async use(_ctx: Ctx, next: () => Promise<Response>) {
    const res = await next();
    res.headers.set('x-stamp', 'real');
    return res;
  }
}

@Controller('/greet')
@UseMiddleware(StampMiddleware)
class GreetController {
  readonly greeter = inject(Greeter);

  @Get('/') greet(ctx: Ctx) {
    return { message: this.greeter.greet(String(ctx.query.name ?? 'world')) };
  }
  @Get('/secret') @UseGuards(AuthGuard) secret() {
    return 'secret';
  }
  @Get('/boom') boom() {
    throw new Error('exploded');
  }
}

@Module({ controllers: [GreetController], providers: [Greeter] })
class GreetModule {}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

describe('Test.createModule', () => {
  test('compiles a module and resolves providers', async () => {
    mod = await Test.createModule({ imports: [GreetModule] }).compile();
    expect(mod.get(Greeter).greet('x')).toBe('hello x');
  });

  test('overrideProvider replaces a provider', async () => {
    mod = await Test.createModule({ imports: [GreetModule] })
      .overrideProvider(Greeter)
      .useValue({ greet: () => 'fake' })
      .compile();
    const app = await mod.createApp();
    const res = await app.request('GET', '/greet', { query: { name: 'ada' } });
    expect(await res.json()).toEqual({ message: 'fake' });
  });

  test('overrideGuard and overrideMiddleware replace framework-constructed classes', async () => {
    mod = await Test.createModule({ imports: [GreetModule] })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideMiddleware(StampMiddleware)
      .useValue({ use: async (_ctx, next) => next() })
      .compile();
    const app = await mod.createApp();
    const res = await app.request('GET', '/greet/secret');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-stamp')).toBeNull();
  });

  test('request() builds query strings and JSON bodies', async () => {
    @Controller('/echo')
    class Echo {
      @Get('/') q(ctx: Ctx) {
        return ctx.query;
      }
    }
    mod = await Test.createModule({ controllers: [Echo] }).compile();
    const app = await mod.createApp();
    expect(
      await (await app.request('GET', '/echo', { query: { a: ['1', '2'], b: 'x' } })).json(),
    ).toEqual({
      a: ['1', '2'],
      b: 'x',
    });
    expect(app.url.hostname).toBe('127.0.0.1');
    expect(await mod.createApp()).toBe(app);
  });

  test('request() and graphqlSubscribe() always target the test server, even for //host paths', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        seen.push(`${req.headers.get('host')} ${new URL(req.url).pathname}`);
        return new Response('ok');
      },
    });
    try {
      const app = new TestApp({ url: new URL(server.url.href) } as HttpApplication);
      const host = `127.0.0.1:${server.port}`;
      expect((await app.request('GET', '//evil.example/x')).status).toBe(200);
      expect((await app.request('GET', '//admin', { query: { a: '1' } })).status).toBe(200);
      // Both reach the test server (Bun's fetch collapses the leading `//` on the wire).
      expect(seen).toEqual([`${host} /evil.example/x`, `${host} /admin`]);
      for (const path of ['http://evil.example/x', 'x', '']) {
        await expect(app.request('GET', path)).rejects.toThrow(TypeError);
        await expect(app.graphqlSubscribe('{ x }', { path })).rejects.toThrow(TypeError);
      }
    } finally {
      server.stop(true);
    }
  });

  test('concurrent createApp() calls listen once and return the same TestApp', async () => {
    mod = await Test.createModule({ imports: [GreetModule] }).compile();
    const [a, b] = await Promise.all([mod.createApp(), mod.createApp()]);
    expect(a).toBe(b);
  });

  test('a failed createApp() is not cached, so a retry can start a new TestApp', async () => {
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    try {
      mod = await Test.createModule({ imports: [GreetModule] }).compile();
      await expect(mod.createApp({ port: blocker.port })).rejects.toThrow();
    } finally {
      blocker.stop(true);
    }
    const app = await mod.createApp();
    expect(app).toBeInstanceOf(TestApp);
    expect(app.url.port).not.toBe('0');
    expect((await app.request('GET', '/greet')).status).toBe(200);
    expect(await mod.createApp()).toBe(app);
  });

  test('development defaults to true and errors are captured in logs', async () => {
    mod = await Test.createModule({ imports: [GreetModule] }).compile();
    const app = await mod.createApp();
    const res = await app.request('GET', '/greet/boom');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { detail: string }).detail).toBe('exploded');
    expect(mod.logs.some((e) => e.level === 'error')).toBe(true);
  });

  test('request() sends json bodies and keeps a caller-provided content-type', async () => {
    @Controller('/echo')
    class Echo {
      @Post('/') async echo(ctx: Ctx) {
        return { type: ctx.req.headers.get('content-type'), body: await ctx.json() };
      }
    }
    mod = await Test.createModule({ controllers: [Echo] }).compile();
    const app = await mod.createApp();
    const res = await app.request('POST', '/echo', { json: { a: 1 } });
    expect(await res.json()).toEqual({ type: 'application/json', body: { a: 1 } });
    const custom = await app.request('POST', '/echo', {
      json: { a: 2 },
      headers: { 'content-type': 'application/vnd.test+json' },
    });
    expect(await custom.json()).toEqual({ type: 'application/vnd.test+json', body: { a: 2 } });
  });

  test('overrideProvider supports useClass and useFactory', async () => {
    class FakeGreeter extends Greeter {
      override greet() {
        return 'class';
      }
    }
    mod = await Test.createModule({ imports: [GreetModule] })
      .overrideProvider(Greeter)
      .useClass(FakeGreeter)
      .compile();
    expect(mod.get(Greeter).greet('x')).toBe('class');
    await mod.close();
    mod = await Test.createModule({ imports: [GreetModule] })
      .overrideProvider(Greeter)
      .useFactory(() => ({ greet: () => 'factory' }))
      .compile();
    expect(mod.get(Greeter).greet('x')).toBe('factory');
  });

  test('overrideFilter replaces a filter referenced via @UseFilters', async () => {
    class RealFilter {
      catch() {
        return new Response('real', { status: 500 });
      }
    }
    @Controller('/f')
    @UseFilters(RealFilter)
    class FilterController {
      @Get('/') f() {
        throw new Error('x');
      }
    }
    mod = await Test.createModule({ controllers: [FilterController] })
      .overrideFilter(RealFilter)
      .useValue({ catch: () => new Response('filtered', { status: 418 }) })
      .compile();
    const res = await (await mod.createApp()).request('GET', '/f');
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('filtered');
  });

  test('compile({ logger }) uses the custom logger', async () => {
    const custom = new MemoryLogger();
    mod = await Test.createModule({ imports: [GreetModule] }).compile({ logger: custom });
    expect(mod.logger).toBe(custom);
    await (await mod.createApp()).request('GET', '/greet/boom');
    expect(custom.entries.some((e) => e.level === 'error')).toBe(true);
  });

  test('logs is empty with a logger that is not a MemoryLogger', async () => {
    const calls: string[] = [];
    const plain = {
      debug: (m: string) => calls.push(m),
      info: (m: string) => calls.push(m),
      warn: (m: string) => calls.push(m),
      error: (m: string) => calls.push(m),
    };
    mod = await Test.createModule({ imports: [GreetModule] }).compile({ logger: plain });
    expect(mod.logger).toBe(plain);
    await (await mod.createApp()).request('GET', '/greet/boom');
    expect(calls.length).toBeGreaterThan(0);
    expect(mod.logs).toEqual([]);
  });
});

describe('the testing logger', () => {
  test('captures every module, replacing global and module-local LOGGER providers', async () => {
    const local = new MemoryLogger();
    @Injectable()
    class LocalService {
      readonly log = inject(LOGGER);
    }
    @Module({ providers: [{ provide: LOGGER, useValue: local }, LocalService] })
    class Feature {}
    @Module({ imports: [Feature] })
    class App {}
    const mod = await Test.createModule({ imports: [App] }).compile();
    try {
      mod.get(LocalService).log.info('captured');
      expect(mod.logs).toContainEqual({ level: 'info', message: 'captured', meta: [] });
      expect(local.entries).toEqual([]);
    } finally {
      await mod.close();
    }
  });
});
