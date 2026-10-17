import { describe, expect, test } from 'bun:test';
import { ApplicationContext, inject, Module } from '@knead-js/core';
import type { RequestContext } from '../src/context.js';
import { Catch } from '../src/decorators.js';
import {
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '../src/exceptions.js';
import { MemoryLogger } from '../src/logger.js';
import {
  composeMiddleware,
  createErrorHandler,
  defaultErrorResponse,
  runGuards,
} from '../src/pipeline.js';
import { resolveFilter, resolveGuard, resolveMiddleware } from '../src/resolve.js';
import type { ExceptionFilter, Middleware } from '../src/types.js';
import { makeCtx } from './helpers.js';

const logger = new MemoryLogger();
const onError = createErrorHandler([], logger, false);
const ok = async () => new Response('handler');

describe('composeMiddleware', () => {
  test('runs as an onion', async () => {
    const log: string[] = [];
    const mw = (name: string): Middleware => ({
      async use(_ctx, next) {
        log.push(`${name}:before`);
        const res = await next();
        log.push(`${name}:after`);
        return res;
      },
    });
    const handler = composeMiddleware(
      [mw('a'), mw('b')],
      async () => {
        log.push('handler');
        return new Response('ok');
      },
      onError,
    );
    expect(await (await handler(makeCtx('/'))).text()).toBe('ok');
    expect(log).toEqual(['a:before', 'b:before', 'handler', 'b:after', 'a:after']);
  });

  test('middleware can short-circuit', async () => {
    const handler = composeMiddleware(
      [{ use: () => new Response('blocked', { status: 401 }) }],
      ok,
      onError,
    );
    expect((await handler(makeCtx('/'))).status).toBe(401);
  });

  test('errors become responses at their own layer so outer middleware can decorate them (Review Focus 2)', async () => {
    const outer: Middleware = {
      async use(_ctx, next) {
        const res = await next();
        res.headers.set('x-outer', 'seen');
        return res;
      },
    };
    const throwing: Middleware = {
      use() {
        throw new HttpException(429, 'slow down', { headers: { 'retry-after': '5' } });
      },
    };
    const res = await composeMiddleware([outer, throwing], ok, onError)(makeCtx('/limited'));
    expect(res.status).toBe(429);
    expect(res.headers.get('x-outer')).toBe('seen');
    expect(res.headers.get('retry-after')).toBe('5');
    expect(((await res.json()) as { instance: string }).instance).toBe('/limited');
  });

  test('calling next() twice is an error', async () => {
    const twice: Middleware = {
      async use(_ctx, next) {
        await next();
        return next();
      },
    };
    expect((await composeMiddleware([twice], ok, onError)(makeCtx('/'))).status).toBe(500);
  });

  test('middleware that does not return a Response is an error', async () => {
    const broken = { use: async () => 'oops' } as unknown as Middleware;
    expect((await composeMiddleware([broken], ok, onError)(makeCtx('/'))).status).toBe(500);
  });
});

describe('runGuards', () => {
  test('passes when every guard allows', async () => {
    await runGuards([{ canActivate: () => true }, { canActivate: async () => true }], makeCtx('/'));
  });
  test('false becomes ForbiddenException', async () => {
    await expect(runGuards([{ canActivate: () => false }], makeCtx('/'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  test('guards may throw their own exceptions', async () => {
    const guard = {
      canActivate(): boolean {
        throw new UnauthorizedException();
      },
    };
    await expect(runGuards([guard], makeCtx('/'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('createErrorHandler', () => {
  @Catch(TypeError)
  class TypeErrorFilter implements ExceptionFilter<TypeError> {
    catch(error: TypeError) {
      return new Response(`type:${error.message}`, { status: 422 });
    }
  }
  class CatchAll implements ExceptionFilter {
    catch() {
      return new Response('all', { status: 418 });
    }
  }

  test('the first matching filter wins; @Catch restricts types', async () => {
    const handle = createErrorHandler([new TypeErrorFilter(), new CatchAll()], logger, false);
    expect(await (await handle(new TypeError('bad'), makeCtx('/'))).text()).toBe('type:bad');
    expect((await handle(new RangeError('x'), makeCtx('/'))).status).toBe(418);
  });

  test('a throwing filter falls back to the default response and is logged', async () => {
    logger.clear();
    const broken: ExceptionFilter = {
      catch() {
        throw new Error('filter broke');
      },
    };
    const res = await createErrorHandler(
      [broken],
      logger,
      false,
    )(new NotFoundException(), makeCtx('/x'));
    expect(res.status).toBe(404);
    expect(logger.entries.some((e) => e.level === 'error' && e.message.includes('filter'))).toBe(
      true,
    );
  });

  test('a filter returning a non-Response is logged and falls back to the default response', async () => {
    logger.clear();
    class StringFilter {
      catch() {
        return 'oops';
      }
    }
    const bad = new StringFilter() as unknown as ExceptionFilter;
    const res = await createErrorHandler(
      [bad],
      logger,
      false,
    )(new NotFoundException(), makeCtx('/y'));
    expect(res.status).toBe(404);
    expect(
      logger.entries.some((e) => e.level === 'error' && e.message.includes('StringFilter')),
    ).toBe(true);
  });

  test('unknown errors are 500 problem+json, detailed only in development', async () => {
    logger.clear();
    const prod = await createErrorHandler([], logger, false)(new Error('secret'), makeCtx('/p'));
    expect(prod.status).toBe(500);
    expect(prod.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    const body = (await prod.json()) as { correlationId: string };
    expect(body as unknown).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/p',
      correlationId: expect.any(String),
    });
    // Production logs only name, message and the correlation id: no stack, cause or properties.
    const entry = logger.entries.at(-1)!;
    expect(entry.level).toBe('error');
    expect(entry.message).toBe(
      `Unhandled error on GET /p (correlation id ${body.correlationId}): Error: secret`,
    );
    expect(entry.meta).toEqual([]);
    const dev = (await (
      await createErrorHandler([], logger, true)(new Error('secret'), makeCtx('/p'))
    ).json()) as {
      detail: string;
      stack: unknown;
    };
    expect(dev.detail).toBe('secret');
    expect(typeof dev.stack).toBe('string');
  });

  test('development detail, stack and the logged error are redacted', async () => {
    logger.clear();
    const error = Object.assign(new Error('connect redis://app:pw@cache failed'), {
      config: { headers: { authorization: 'Bearer t' } },
    });
    const dev = (await (
      await createErrorHandler([], logger, true)(error, makeCtx('/p'))
    ).json()) as { detail: string; stack: string };
    expect(dev.detail).toBe('connect redis://***@cache failed');
    expect(dev.stack).not.toContain('app:pw');
    const logged = logger.entries.at(-1)!.meta[0] as string;
    expect(logged).toContain('redis://***@cache');
    expect(logged).not.toContain('app:pw');
    expect(logged).not.toContain('Bearer t');
  });

  test('a production summary is redacted before it is truncated', async () => {
    logger.clear();
    // The cut at 500 characters falls inside the userinfo.
    const message = `${'x'.repeat(480)} redis://admin:${'p'.repeat(100)}@cache`;
    await createErrorHandler([], logger, false)(new Error(message), makeCtx('/p'));
    const text = logger.entries.at(-1)!.message;
    expect(text).not.toContain('admin');
    expect(text).not.toContain('ppp');
    // A trailing scheme fragment without its '@' is dropped too.
    logger.clear();
    const cut = `${'x'.repeat(490)} redis://admin:${'p'.repeat(2000)}@cache`;
    await createErrorHandler([], logger, false)(new Error(cut), makeCtx('/p'));
    expect(logger.entries.at(-1)!.message).not.toContain('redis://');
  });
});

describe('declining filters', () => {
  const declines: ExceptionFilter = { catch: () => undefined };
  const answers418: ExceptionFilter = { catch: () => new Response('teapot', { status: 418 }) };

  test('a filter returning undefined passes to the next filter', async () => {
    const mem = new MemoryLogger();
    const res = await createErrorHandler(
      [declines, answers418],
      mem,
      false,
    )(new Error('x'), makeCtx('/'));
    expect(res.status).toBe(418);
    expect(mem.entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  test('all filters declining falls back to the default mapping', async () => {
    const mem = new MemoryLogger();
    const res = await createErrorHandler(
      [declines],
      mem,
      false,
    )(new NotFoundException(), makeCtx('/missing'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { status: number }).status).toBe(404);
    expect(mem.entries.some((e) => e.message.includes('did not return a Response'))).toBe(false);
  });

  test('a filter returning a non-Response non-undefined value still logs and stops', async () => {
    const mem = new MemoryLogger();
    const bad = { catch: () => ({}) } as unknown as ExceptionFilter;
    const res = await createErrorHandler(
      [bad, answers418],
      mem,
      false,
    )(new Error('x'), makeCtx('/'));
    expect(res.status).toBe(500);
    const errors = mem.entries.filter((e) => e.message.includes('did not return a Response'));
    expect(errors).toHaveLength(1);
  });

  test('a declining filter, then a non-Response one, stops before later filters', async () => {
    const mem = new MemoryLogger();
    const bad = { catch: () => ({}) } as unknown as ExceptionFilter;
    const res = await createErrorHandler(
      [declines, bad, answers418],
      mem,
      false,
    )(new Error('x'), makeCtx('/'));
    expect(res.status).toBe(500);
    expect(mem.entries.filter((e) => e.message.includes('did not return a Response'))).toHaveLength(
      1,
    );
  });

  test('a declined 5xx HttpException is masked in production', async () => {
    const mem = new MemoryLogger();
    const res = await createErrorHandler(
      [declines],
      mem,
      false,
    )(new InternalServerErrorException('secret detail'), makeCtx('/boom'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBeUndefined();
    expect(typeof body.correlationId).toBe('string');
    expect(JSON.stringify(body)).not.toContain('secret detail');
  });

  test('defaultErrorResponse is exported and masks 5xx outside development', async () => {
    const mem = new MemoryLogger();
    const res = defaultErrorResponse(
      new InternalServerErrorException('secret'),
      { req: new Request('http://localhost/x') },
      mem,
      false,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBeUndefined();
    expect(typeof body.correlationId).toBe('string');
  });
});

describe('resolve refs', () => {
  class Clock {
    now() {
      return 42;
    }
  }
  class TimeMiddleware implements Middleware {
    readonly clock = inject(Clock);
    async use(_ctx: RequestContext, next: () => Promise<Response>) {
      const res = await next();
      res.headers.set('x-time', String(this.clock.now()));
      return res;
    }
  }
  class AllowGuard {
    canActivate() {
      return true;
    }
  }

  test('classes are constructed through DI; functions and objects are adapted', async () => {
    @Module({ providers: [Clock] })
    class AppModule {}
    const app = await ApplicationContext.create(AppModule);
    const injector = app.root.injector;
    const mw = resolveMiddleware(TimeMiddleware, injector);
    const res = await mw.use(makeCtx('/'), ok);
    expect(res.headers.get('x-time')).toBe('42');
    const fnMw = resolveMiddleware((_ctx, next) => next(), injector);
    expect(await (await fnMw.use(makeCtx('/'), ok)).text()).toBe('handler');
    expect(await resolveGuard(AllowGuard, injector).canActivate(makeCtx('/'))).toBe(true);
    expect(await resolveGuard(() => false, injector).canActivate(makeCtx('/'))).toBe(false);
    const filter = { catch: () => new Response('f') };
    expect(resolveFilter(filter, injector)).toBe(filter);
  });
});
