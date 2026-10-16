import { afterEach, describe, expect, test } from 'bun:test';
import { ApplicationContext, inject, LOGGER, type LogLevel, Module } from '@knead-js/core';
import { Controller, Get, type HttpApplication, KneadFactory, MemoryLogger } from '@knead-js/http';
import { JsonLogger, LoggingConfigError, LoggingModule } from '../src/index.js';

function sink() {
  const lines: string[] = [];
  const write = (line: string, _level: LogLevel) => lines.push(line);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, write, records };
}

describe('LoggingModule with ApplicationContext', () => {
  test('provides a JsonLogger as LOGGER and as JsonLogger, injectable from any module', async () => {
    const { write, records } = sink();
    class Service {
      readonly log = inject(LOGGER);
      readonly json = inject(JsonLogger);
    }
    @Module({ providers: [Service], exports: [Service] })
    class Feature {}
    @Module({ imports: [LoggingModule.forRoot({ write }), Feature] })
    class App {}
    const ctx = await ApplicationContext.create(App);
    const service = ctx.get(Service);
    expect(service.log).toBeInstanceOf(JsonLogger);
    expect(service.log).toBe(service.json);
    expect(ctx.get(LOGGER)).toBe(service.json);
    service.json.child({ job: 'report' }).info('done');
    expect(records()).toEqual([expect.objectContaining({ msg: 'done', job: 'report' })]);
  });

  test("development comes from the application's DEVELOPMENT flag", async () => {
    for (const development of [true, false]) {
      const { write, records } = sink();
      @Module({ imports: [LoggingModule.forRoot({ write })] })
      class App {}
      const ctx = await ApplicationContext.create(App, { development });
      ctx.get(LOGGER).debug('d', new Error('e'));
      // debug is written only in development, where errors carry their stack.
      expect(records().length).toBe(development ? 1 : 0);
      if (development) expect(records()[0]!.err).toContain(' at ');
    }
  });

  test('an explicit development option wins over the flag', async () => {
    const { write, records } = sink();
    @Module({ imports: [LoggingModule.forRoot({ write, development: false })] })
    class App {}
    const ctx = await ApplicationContext.create(App, { development: true });
    ctx.get(LOGGER).error('x', new Error('e'));
    expect(records()[0]!.err).toBe('Error: e');
  });

  test('invalid options fail at forRoot()', () => {
    expect(() => LoggingModule.forRoot({ level: 'loud' as LogLevel })).toThrow(LoggingConfigError);
  });
});

describe('LoggingModule with KneadFactory', () => {
  let app: HttpApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  @Controller('/')
  class Boom {
    @Get('/boom') boom(): never {
      throw new Error('connect redis://admin:s3cret@cache failed');
    }
  }

  test('replaces the default logger, including for request errors', async () => {
    const { lines, write, records } = sink();
    @Module({ imports: [LoggingModule.forRoot({ write })], controllers: [Boom] })
    class App {}
    app = await KneadFactory.create(App, { development: false });
    expect(app.logger).toBeInstanceOf(JsonLogger);
    expect(app.get(LOGGER)).toBe(app.logger);
    await app.listen({ port: 0, hostname: '127.0.0.1' });
    const res = await fetch(new URL('/boom', app.url));
    expect(res.status).toBe(500);
    const error = records().find((r) => r.level === 'error');
    expect(error?.msg).toContain('correlation id');
    expect(JSON.stringify(error)).toContain('redis://***@cache');
    expect(lines.join('\n')).not.toContain('s3cret');
  });

  test('an explicit logger option still wins', async () => {
    const { write } = sink();
    const mem = new MemoryLogger();
    @Module({ imports: [LoggingModule.forRoot({ write })] })
    class App {}
    app = await KneadFactory.create(App, { logger: mem });
    expect(app.logger).toBe(mem);
    expect(app.get(LOGGER)).toBe(mem);
  });
});
