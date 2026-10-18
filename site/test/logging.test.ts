import { afterEach, describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  ConsoleLogger,
  Injectable,
  inject,
  LOGGER,
  type Logger,
  type LogLevel,
  MemoryLogger,
  Module,
  redactCredentials,
  redactValue,
} from '@knead-js/core';
import { Controller, Get, KneadFactory } from '@knead-js/http';
import { JsonLogger, LoggingConfigError, LoggingModule } from '@knead-js/logging';
import { Test } from '@knead-js/testing';
import { AppModule } from '../snippets/logging/app.module.js';
import { InvoiceJob } from '../snippets/logging/child.js';
import { OrdersLoggerModule } from '../snippets/logging/console-logger.js';
import { createApp } from '../snippets/logging/factory.js';
import { OrdersService, PaymentDeclinedError } from '../snippets/logging/orders.service.js';
import { Logging, shipper } from '../snippets/logging/sink.js';
import { log as standaloneLog } from '../snippets/logging/standalone.js';

const TIME = '2026-10-17T09:30:00.000Z';
const now = () => new Date(TIME);

function capture(development = false, extra: Record<string, unknown> = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = new JsonLogger({
    development,
    now,
    write: (line, level) => {
      lines.push({ line, level });
    },
    ...extra,
  });
  return { logger, lines, text: () => lines.map((l) => l.line) };
}

/** Captures what the default sink writes to stdout and stderr. */
async function captureStreams(run: () => Promise<void> | void) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string) => out.push(chunk) > 0) as typeof stdout;
  process.stderr.write = ((chunk: string) => err.push(chunk) > 0) as typeof stderr;
  try {
    await run();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { out, err };
}

const stripTime = (line: string) => line.replace(/"time":"[^"]+"/, `"time":"${TIME}"`);

const order = { id: 'ord_1042', customerId: 'cus_7', totalCents: 4999 };

describe('logging: the default logger', () => {
  test('KneadFactory defaults to one ConsoleLogger', async () => {
    @Module({})
    class Empty {}
    const app = await KneadFactory.create(Empty);
    expect(app.logger).toBeInstanceOf(ConsoleLogger);
    await app.close();
  });

  test('ConsoleLogger prefixes, redacts and escapes', () => {
    const calls: unknown[][] = [];
    const info = console.info;
    console.info = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      new ConsoleLogger().info('connected to redis://app:hunter2@cache:6379\nforged', {
        password: 'hunter2',
        user: 'ada',
      });
      new ConsoleLogger('orders').info('ready');
    } finally {
      console.info = info;
    }
    expect(calls).toEqual([
      ['[knead] connected to redis://***@cache:6379\\nforged', { password: '***', user: 'ada' }],
      ['[orders] ready'],
    ]);
  });

  test('a global module providing LOGGER is used everywhere', async () => {
    @Injectable()
    class Feature {
      readonly log = inject(LOGGER);
    }
    @Module({ providers: [Feature], exports: [Feature] })
    class FeatureModule {}
    @Module({ imports: [OrdersLoggerModule, FeatureModule] })
    class App {}
    const app = await KneadFactory.create(App);
    expect(app.logger).toBeInstanceOf(ConsoleLogger);
    expect(app.get(Feature).log).toBe(app.logger);
    await app.close();
  });

  test('MemoryLogger keeps entries unredacted', () => {
    const memory = new MemoryLogger();
    memory.warn('token=abc123', { password: 'hunter2' });
    expect(memory.entries).toEqual([
      { level: 'warn', message: 'token=abc123', meta: [{ password: 'hunter2' }] },
    ]);
    memory.clear();
    expect(memory.entries).toEqual([]);
  });
});

describe('logging: redaction', () => {
  test('redactCredentials', () => {
    expect(redactCredentials('redis://app:hunter2@cache:6379')).toBe('redis://***@cache:6379');
    expect(redactCredentials('postgres://app:p@ss/w0rd@db/shop')).toBe('postgres://***@db/shop');
    expect(redactCredentials('https://example.com/users/@ada')).toBe(
      'https://example.com/users/@ada',
    );
    expect(redactCredentials('GET /callback?code=1&client_secret=abc&state=2')).toBe(
      'GET /callback?code=1&client_secret=***&state=2',
    );
    expect(redactCredentials('DB_PASSWORD=hunter2 PGPASSWORD=x;next')).toBe(
      'DB_PASSWORD=*** PGPASSWORD=***;next',
    );
    expect(redactCredentials('Authorization: Bearer eyJhbGciOi.payload.sig')).toBe(
      'Authorization: Bearer ***',
    );
    expect(redactCredentials('Basic YWRhOmh1bnRlcjI=')).toBe('Basic ***');
    expect(redactCredentials('Bearer abc123')).toBe('Bearer abc123');
    expect(redactCredentials('a basic mistake')).toBe('a basic mistake');
  });

  test('redactValue', () => {
    const input = {
      authorization: 'Bearer x',
      db_password: 'hunter2',
      'x-api-key': 'k',
      clientSecret: 's',
      sessionId: 's1',
      maxTokens: 100,
      token: 42,
      url: 'redis://app:hunter2@cache',
      user: { name: 'ada', cookie: 'sid=1' },
    };
    expect(redactValue(input)).toEqual({
      authorization: '***',
      db_password: '***',
      'x-api-key': '***',
      clientSecret: '***',
      sessionId: '***',
      maxTokens: 100,
      token: '***',
      url: 'redis://***@cache',
      user: { name: 'ada', cookie: '***' },
    });
    expect(input.db_password).toBe('hunter2');
    const clean = { id: 1 };
    expect(redactValue(clean)).toBe(clean);
    expect(redactValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      a: { b: { c: { d: '[Object]' } } },
    });
  });
});

describe('logging: JsonLogger records', () => {
  test('the documented order-placed line', () => {
    const { logger, text } = capture(false, { name: 'orders-api', fields: { service: 'orders' } });
    logger.info('order placed', { orderId: 'ord_1042', totalCents: 4999 });
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"orders-api","msg":"order placed","service":"orders","orderId":"ord_1042","totalCents":4999}',
    ]);
  });

  test('AppModule writes NDJSON to stdout and stderr', async () => {
    const { out, err } = await captureStreams(async () => {
      const app = await KneadFactory.create(AppModule, { development: false });
      const orders = app.get(OrdersService);
      orders.place(order);
      orders.charge(order, new PaymentDeclinedError('card ending 4242 was declined'));
      app.logger.debug('not written outside development');
      await app.close();
    });
    expect(out.map(stripTime)).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"orders-api","msg":"order placed","service":"orders","orderId":"ord_1042","totalCents":4999}\n',
    ]);
    expect(err.map(stripTime)).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"error","logger":"orders-api","msg":"payment failed","service":"orders","orderId":"ord_1042","err":"PaymentDeclinedError: card ending 4242 was declined"}\n',
    ]);
  });

  test('meta: objects merge, the first Error is err, the rest is meta', () => {
    const { logger, text } = capture();
    logger.warn(
      'retrying',
      { attempt: 2 },
      new Error('timeout'),
      'upstream',
      7,
      { attempt: 3, time: 'x', msg: 'y' },
      new Error('second'),
    );
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"warn","logger":"knead","msg":"retrying","attempt":3,"err":"Error: timeout","meta":["upstream",7,"Error: second"]}',
    ]);
  });

  test('value conversions', () => {
    const { logger, text } = capture();
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    logger.info('values', {
      big: 10n,
      when: new Date(TIME),
      point: new Point(1, 2),
      tags: new Set(['a', 'b']),
      counts: new Map([['a', 1]]),
      headers: new Headers({ authorization: 'Bearer abcdefghijkl', accept: 'text/html' }),
      bytes: new Uint8Array(16),
      cyclic,
      deep: { a: { b: { c: { d: 1 } } } },
      skipped: undefined,
      fn: () => 1,
    });
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"knead","msg":"values","big":"10","when":"2026-10-17T09:30:00.000Z","point":{"x":1,"y":2},"tags":["a","b"],"counts":{"a":1},"headers":{"accept":"text/html","authorization":"***"},"bytes":"[Uint8Array 16 bytes]","cyclic":{"id":1,"self":"[Circular]"},"deep":{"a":{"b":{"c":"[Object]"}}}}',
    ]);
  });

  test('redaction in records', () => {
    const { logger, text } = capture(false, { fields: { apiKey: 'k-123' } });
    logger.info('connect redis://app:hunter2@cache:6379', {
      password: 'hunter2',
      callback: '/cb?access_token=abc',
    });
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"knead","msg":"connect redis://***@cache:6379","apiKey":"***","password":"***","callback":"/cb?access_token=***"}',
    ]);
  });

  test('a newline or U+2028 cannot start another record', () => {
    const { logger, lines } = capture();
    logger.info('line one\n{"level":"error"} ');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toBe(
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"knead","msg":"line one\\n{\\"level\\":\\"error\\"}\\u2028"}',
    );
  });

  test('limits', () => {
    const { logger, lines } = capture();
    const wide = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => [`k${i}`, i]));
    logger.info('limits', { list: Array.from({ length: 1003 }, (_, i) => i), wide });
    const record = JSON.parse(lines[0]!.line) as { list: unknown[]; wide: Record<string, unknown> };
    expect(record.list).toHaveLength(1001);
    expect(record.list.at(-1)).toBe('[3 more items]');
    expect(record.wide['…']).toBe('5 more keys omitted');
  });

  test('errors outside and inside development', () => {
    const error = new Error('query failed for postgres://app:hunter2@db/shop', {
      cause: new Error('connection reset'),
    });
    error.stack = 'Error: query failed for postgres://app:hunter2@db/shop\n    at run (db.ts:10:5)';
    (error.cause as Error).stack = 'Error: connection reset\n    at socket (net.ts:3:1)';
    Object.assign(error, { code: 'ECONNRESET', password: 'hunter2' });

    const prod = capture(false);
    prod.logger.error('query failed', error);
    expect(prod.text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"error","logger":"knead","msg":"query failed","err":"Error: query failed for postgres://***@db/shop"}',
    ]);

    const dev = capture(true);
    dev.logger.error('query failed', error);
    const record = JSON.parse(dev.lines[0]!.line) as { err: string };
    expect(record.err).toBe(
      'Error: query failed for postgres://***@db/shop\n' +
        '    at run (db.ts:10:5)\n' +
        '  {"code":"ECONNRESET","password":"***"}\n' +
        'Caused by: Error: connection reset\n' +
        '    at socket (net.ts:3:1)',
    );
  });

  test('levels: default info outside development, debug in development, level option', () => {
    const prod = capture(false);
    prod.logger.debug('d');
    prod.logger.info('i');
    expect(prod.lines.map((l) => l.level)).toEqual(['info']);
    const dev = capture(true);
    dev.logger.debug('d');
    expect(dev.lines.map((l) => l.level)).toEqual(['debug']);
    const warn = capture(true, { level: 'warn' });
    warn.logger.info('i');
    warn.logger.warn('w');
    warn.logger.error('e');
    expect(warn.lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  test('default sink splits stdout and stderr; standalone logger writes warn and up', async () => {
    const { out, err } = await captureStreams(() => {
      standaloneLog.info('skipped');
      standaloneLog.warn('slow shard', { shard: 3 });
    });
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0]!)).toMatchObject({ level: 'warn', logger: 'reindex', shard: 3 });
    expect(err[0]!.endsWith('\n')).toBe(true);
  });

  test('a throwing sink never reaches the caller', () => {
    const logger = new JsonLogger({
      write: () => {
        throw new Error('disk full');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });
});

describe('logging: options and module', () => {
  test('invalid options are a LoggingConfigError', () => {
    expect(() => new JsonLogger({ level: 'verbose' as LogLevel })).toThrow(
      new LoggingConfigError(
        'JsonLogger level must be one of debug, info, warn, error, got verbose',
      ),
    );
    expect(() => LoggingModule.forRoot({ name: '' })).toThrow(
      'JsonLogger name must be a non-empty string',
    );
    expect(() => new JsonLogger({ fields: new Map() as never })).toThrow(
      'JsonLogger fields must be a plain object without toJSON',
    );
  });

  test('LoggingModule without forRoot, or forRoot twice, fails at startup', async () => {
    @Module({ imports: [LoggingModule] })
    class Bare {}
    await expect(KneadFactory.create(Bare)).rejects.toThrow(
      'Import LoggingModule.forRoot(), not LoggingModule',
    );
    @Module({ imports: [LoggingModule.forRoot()] })
    class Feature {}
    @Module({ imports: [LoggingModule.forRoot(), Feature] })
    class Twice {}
    await expect(KneadFactory.create(Twice)).rejects.toThrow(
      'LoggingModule.forRoot() is imported 2 times; import it once, in the root module',
    );
  });

  test('development follows the application flag', async () => {
    for (const development of [true, false]) {
      const records: string[] = [];
      @Module({
        imports: [LoggingModule.forRoot({ write: (line) => records.push(line) })],
      })
      class App {}
      const app = await KneadFactory.create(App, { development });
      app.logger.debug('d');
      expect(records).toHaveLength(development ? 1 : 0);
      await app.close();
    }
  });

  test('a custom sink receives each line and its level', async () => {
    shipper.pending.length = 0;
    @Module({ imports: [Logging] })
    class App {}
    const ctx = await ApplicationContext.create(App, { development: false });
    ctx.get(LOGGER).warn('disk at 91%');
    expect(shipper.pending).toHaveLength(1);
    expect(shipper.pending[0]!.level).toBe('warn');
    expect(JSON.parse(shipper.pending[0]!.line)).toMatchObject({ msg: 'disk at 91%' });
    await ctx.close();
  });

  test('framework error lines', async () => {
    const lines: string[] = [];
    @Controller('/reports')
    class Reports {
      @Get('/') list() {
        throw new Error('replica postgres://app:hunter2@db/shop is down');
      }
      @Get('/plain') plain() {
        throw new Error('plain failure');
      }
    }
    @Module({
      imports: [LoggingModule.forRoot({ now, write: (line) => lines.push(line) })],
      controllers: [Reports],
    })
    class App {}
    for (const development of [false, true]) {
      lines.length = 0;
      const app = await KneadFactory.create(App, { development });
      await app.listen({ port: 0, hostname: '127.0.0.1' });
      const res = await fetch(new URL('/reports', app.url));
      const { correlationId } = (await res.json()) as { correlationId: string };
      const plain = await fetch(new URL('/reports/plain', app.url));
      await plain.body?.cancel();
      await app.close();
      const errors = lines.map((l) => JSON.parse(l)).filter((r) => r.level === 'error');
      if (!development) {
        expect(errors[0]).toEqual({
          time: TIME,
          level: 'error',
          logger: 'knead',
          msg: `Unhandled error on GET /reports (correlation id ${correlationId}): Error: replica postgres://***@db/shop is down`,
        });
      } else {
        // Redacted or not, the error lands in err with its stack.
        expect(errors[0].msg).toBe(
          `Unhandled error on GET /reports (correlation id ${correlationId})`,
        );
        expect(errors[0].meta).toBeUndefined();
        expect(errors[0].err).toStartWith('Error: replica postgres://***@db/shop is down\n    at ');
        expect(lines.join('\n')).not.toContain('hunter2');
        expect(errors[1].err).toStartWith('Error: plain failure\n    at ');
      }
    }
  });
});

describe('logging: child loggers', () => {
  test('childLogger on a JsonLogger adds fields', async () => {
    const { logger, text } = capture(false, { name: 'billing' });
    const mod = await Test.createModule({ providers: [InvoiceJob] }).compile({ logger });
    mod.get(InvoiceJob).run('b_17', 120);
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch started","component":"invoices","batchId":"b_17","invoices":120}',
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"billing","msg":"batch finished","component":"invoices","batchId":"b_17"}',
    ]);
    await mod.close();
  });

  test('childLogger on any other Logger passes fields as the first meta', async () => {
    const mod = await Test.createModule({ providers: [InvoiceJob] }).compile();
    mod.get(InvoiceJob).run('b_17', 120);
    expect(mod.logs).toEqual([
      {
        level: 'info',
        message: 'batch started',
        meta: [{ component: 'invoices', batchId: 'b_17' }, { invoices: 120 }],
      },
      {
        level: 'info',
        message: 'batch finished',
        meta: [{ component: 'invoices', batchId: 'b_17' }],
      },
    ]);
    await mod.close();
  });

  test('child fields cannot replace reserved keys; child() keeps the parent', () => {
    const { logger, text } = capture();
    const child = logger.child({ msg: 'forged', requestId: 'r1' });
    child.info('hello');
    logger.info('parent');
    expect(text()).toEqual([
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"knead","msg":"hello","requestId":"r1"}',
      '{"time":"2026-10-17T09:30:00.000Z","level":"info","logger":"knead","msg":"parent"}',
    ]);
  });
});

describe('logging: precedence', () => {
  @Injectable()
  class Service {
    readonly log = inject(LOGGER);
  }
  @Module({ providers: [Service], exports: [Service] })
  class Feature {}

  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  test('LoggingModule is the LOGGER everywhere', async () => {
    @Module({ imports: [LoggingModule.forRoot({ write: () => {} }), Feature] })
    class App {}
    const app = await KneadFactory.create(App);
    close = () => app.close();
    expect(app.get(Service).log).toBeInstanceOf(JsonLogger);
  });

  test('the logger option wins over LoggingModule', async () => {
    const app = await createApp();
    close = () => app.close();
    expect(app.logger).toBeInstanceOf(JsonLogger);
    const explicit: Logger = new MemoryLogger();
    @Module({ imports: [LoggingModule.forRoot({ write: () => {} }), Feature] })
    class App {}
    const other = await KneadFactory.create(App, { logger: explicit });
    expect(other.get(Service).log).toBe(explicit);
    await other.close();
  });

  test('tests capture logs in a MemoryLogger even with LoggingModule', async () => {
    @Module({ imports: [LoggingModule.forRoot(), Feature] })
    class App {}
    const mod = await Test.createModule({ imports: [App] }).compile();
    close = () => mod.close();
    mod.get(Service).log.info('captured');
    expect(mod.logs).toEqual([{ level: 'info', message: 'captured', meta: [] }]);
  });
});
