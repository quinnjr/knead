import { describe, expect, test } from 'bun:test';
import { type LogLevel, logError, MemoryLogger } from '@knead-js/core';
import {
  childLogger,
  JsonLogger,
  type JsonLoggerOptions,
  LoggingConfigError,
} from '../src/index.js';

const TIME = new Date('2026-10-16T12:00:00.000Z');

function capture(options: JsonLoggerOptions = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = new JsonLogger({
    now: () => TIME,
    write: (line, level) => lines.push({ line, level }),
    ...options,
  });
  const records = () => lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('record shape', () => {
  test('writes one JSON line with time, level, logger and msg', () => {
    const { logger, lines, records } = capture();
    logger.info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line.endsWith('\n')).toBe(false);
    expect(lines[0]!.line.includes('\n')).toBe(false);
    expect(records()[0]).toEqual({
      time: '2026-10-16T12:00:00.000Z',
      level: 'info',
      logger: 'knead',
      msg: 'hello',
    });
  });

  test('reserved keys come first, in order', () => {
    const { logger, lines } = capture({ fields: { service: 'api' } });
    logger.warn('x', { requestId: 'r1' });
    expect(Object.keys(JSON.parse(lines[0]!.line))).toEqual([
      'time',
      'level',
      'logger',
      'msg',
      'service',
      'requestId',
    ]);
  });

  test('plain-object meta becomes fields, later ones winning; other meta goes to `meta`', () => {
    const { logger, records } = capture({ fields: { a: 1, b: 1 } });
    logger.info('x', { b: 2 }, 'text', 3, [4], { c: 5 }, null);
    expect(records()[0]).toMatchObject({ a: 1, b: 2, c: 5, meta: ['text', 3, [4], null] });
  });

  test('fields cannot overwrite reserved keys', () => {
    const { logger, records } = capture({ fields: { level: 'fake', msg: 'fake' } });
    logger.error('real', { time: 'fake', logger: 'fake' });
    expect(records()[0]).toEqual({
      time: '2026-10-16T12:00:00.000Z',
      level: 'error',
      logger: 'knead',
      msg: 'real',
    });
  });

  test('__proto__, constructor and prototype keys are dropped', () => {
    const { logger, records } = capture();
    logger.info('x', JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "ok": 2}'), {
      nested: JSON.parse('{"__proto__": 1, "prototype": 2, "kept": 3}'),
    });
    const record = records()[0]!;
    expect(Object.hasOwn(record, '__proto__')).toBe(false);
    expect(Object.hasOwn(record, 'constructor')).toBe(false);
    expect(record).toMatchObject({ ok: 2, nested: { kept: 3 } });
    expect(Object.keys(record.nested as object)).toEqual(['kept']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('fields and meta cannot set err or meta', () => {
    const { logger, records } = capture({ development: false, fields: { err: 'f', meta: 'f' } });
    logger.error('x', new Error('real'), { err: 'forged', meta: 'mine' }, 'extra');
    expect(records()[0]).toMatchObject({ err: 'Error: real', meta: ['extra'] });
  });

  test('a field named err does not push the real Error into meta', () => {
    const { logger, records } = capture({ development: false });
    logger.child({ err: 'x' }).error('y', new Error('boom'));
    expect(records()[0]!.err).toBe('Error: boom');
    expect(records()[0]!.meta).toBeUndefined();
  });

  test('the name option sets `logger`', () => {
    const { logger, records } = capture({ name: 'knead:jobs' });
    logger.info('x');
    expect(records()[0]!.logger).toBe('knead:jobs');
  });

  test('bigint is written as a string, undefined fields are dropped', () => {
    const { logger, records } = capture();
    logger.info('x', { big: 12345678901234567890n, gone: undefined });
    expect(records()[0]).toMatchObject({ big: '12345678901234567890' });
    expect(Object.hasOwn(records()[0]!, 'gone')).toBe(false);
  });
});

describe('levels', () => {
  test('defaults to info outside development', () => {
    const { logger, records } = capture({ development: false });
    logger.debug('d');
    logger.info('i');
    expect(records().map((r) => r.msg)).toEqual(['i']);
  });

  test('defaults to debug in development', () => {
    const { logger, records } = capture({ development: true });
    logger.debug('d');
    expect(records().map((r) => r.msg)).toEqual(['d']);
  });

  test('the level option is the minimum level written', () => {
    const { logger, records } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  test('write receives the level', () => {
    const { logger, lines } = capture({ level: 'debug' });
    logger.debug('a');
    logger.error('b');
    expect(lines.map((l) => l.level)).toEqual(['debug', 'error']);
  });
});

describe('redaction', () => {
  test('redacts credentials in the message, string meta, fields and nested objects', () => {
    const { logger, lines } = capture({ fields: { db: 'postgres://u:hunter2@db/app' } });
    logger.info('connect redis://admin:s3cret@cache:6379 failed', 'token=abc123def', {
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
      nested: { password: 'pw-value' },
    });
    const line = lines[0]!.line;
    for (const secret of ['hunter2', 's3cret', 'abc123def', 'eyJhbGci', 'pw-value']) {
      expect(line).not.toContain(secret);
    }
    const record = JSON.parse(line);
    expect(record.msg).toBe('connect redis://***@cache:6379 failed');
    expect(record.db).toBe('postgres://***@db/app');
    expect(record.headers.authorization).toBe('***');
    expect(record.nested.password).toBe('***');
  });

  test('child fields are redacted too', () => {
    const { logger, lines } = capture();
    logger.child({ apiKey: 'k-123456789', url: 'https://u:p4ss@x.example' }).info('x');
    expect(lines[0]!.line).not.toContain('k-123456789');
    expect(lines[0]!.line).not.toContain('p4ss');
  });

  test('control characters cannot forge a second line', () => {
    const { logger, lines } = capture();
    logger.info('a\n{"level":"error","msg":"forged"}\r\u2028\u2029', { v: '\u001b[31m' });
    expect(lines).toHaveLength(1);
    for (const c of ['\n', '\r', '\u2028', '\u2029', '\u001b']) {
      expect(lines[0]!.line.includes(c)).toBe(false);
    }
    expect(JSON.parse(lines[0]!.line).msg).toBe(
      'a\n{"level":"error","msg":"forged"}\r\u2028\u2029',
    );
  });
});

describe('errors', () => {
  const failure = () => {
    const cause = new Error('socket closed');
    return Object.assign(new Error('connect redis://admin:s3cret@cache failed', { cause }), {
      code: 'ECONN',
    });
  };

  test('outside development an Error meta is only `Name: message`, redacted', () => {
    const { logger, records } = capture({ development: false });
    logger.error('request failed', failure());
    const record = records()[0]!;
    expect(record.err).toBe('Error: connect redis://***@cache failed');
    expect(JSON.stringify(record)).not.toContain('socket closed');
    expect(JSON.stringify(record)).not.toContain('ECONN');
    expect(JSON.stringify(record)).not.toContain('    at ');
  });

  test('in development an Error meta has its stack, cause and properties, redacted', () => {
    const { logger, records } = capture({ development: true });
    logger.error('request failed', failure());
    const err = records()[0]!.err as string;
    expect(err).toContain('connect redis://***@cache failed');
    expect(err).not.toContain('s3cret');
    expect(err).toContain('socket closed');
    expect(err).toContain('ECONN');
    expect(err).toContain(' at ');
  });

  test('a development Error with nothing to redact still has its stack and cause', () => {
    const { logger, records } = capture({ development: true });
    logger.error('x', new TypeError('plain', { cause: new Error('inner') }));
    const err = records()[0]!.err as string;
    expect(err).toContain('TypeError: plain');
    expect(err).toContain('inner');
    expect(err).toContain(' at ');
  });

  test('the first Error is `err`, later ones go to `meta`', () => {
    const { logger, records } = capture({ development: false });
    logger.error('x', new Error('one'), new RangeError('two'));
    expect(records()[0]).toMatchObject({ err: 'Error: one', meta: ['RangeError: two'] });
  });

  test('an Error nested in a field is serialized the same way', () => {
    const { logger, records } = capture({ development: false });
    logger.error('x', { job: 'report', error: new Error('token=abcdef123 rejected') });
    expect(records()[0]).toMatchObject({ job: 'report', error: 'Error: token=*** rejected' });
  });

  test('an AggregateError outside development is only its summary', () => {
    const { logger, records } = capture({ development: false });
    logger.error('x', new AggregateError([new Error('password=hunter2')], 'many'));
    expect(records()[0]!.err).toBe('AggregateError: many');
  });
});

describe('child()', () => {
  test('adds fields to every record without changing the parent', () => {
    const { logger, records } = capture({ fields: { service: 'api' } });
    const child = logger.child({ requestId: 'r1' });
    child.info('a', { step: 1 });
    logger.info('b');
    expect(records()).toEqual([
      expect.objectContaining({ service: 'api', requestId: 'r1', step: 1, msg: 'a' }),
      expect.not.objectContaining({ requestId: 'r1' }),
    ]);
  });

  test('keeps the level, name, sink and development flag', () => {
    const { logger, records } = capture({ level: 'warn', name: 'n', development: false });
    const child = logger.child({ a: 1 }).child({ b: 2 });
    child.info('dropped');
    child.warn('kept', new Error('e'));
    expect(records()).toEqual([
      expect.objectContaining({ logger: 'n', a: 1, b: 2, msg: 'kept', err: 'Error: e' }),
    ]);
  });
});

describe('never throws', () => {
  test('a throwing sink is swallowed', () => {
    const logger = new JsonLogger({
      write: () => {
        throw new Error('disk full');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });

  test('cycles in class instances and a throwing toJSON become placeholders', () => {
    const { logger, records } = capture();
    class Node {
      self: unknown = this;
    }
    logger.info('x', new Node(), {
      toJSON() {
        throw new Error('nope');
      },
    });
    expect(records()[0]).toMatchObject({
      msg: 'x',
      meta: [{ self: '[Circular]' }, '[unreadable]'],
    });
  });

  test('a throwing clock or message still writes a record', () => {
    const { logger, records } = capture({
      now: () => {
        throw new Error('clock');
      },
    });
    const message = {
      toString() {
        throw new Error('message');
      },
    } as unknown as string;
    logger.info('x', { a: 1 });
    logger.info(message);
    expect(records()).toEqual([
      expect.objectContaining({ msg: 'x', meta: '[unloggable meta]' }),
      expect.objectContaining({ msg: '[unloggable message]', meta: '[unloggable meta]' }),
    ]);
    expect(typeof records()[0]!.time).toBe('string');
  });

  test('class instances are written as their properties, redacted', () => {
    const { logger, records } = capture();
    class Config {
      host = 'db';
      password = 'hunter2';
      url = new URL('https://u:p4ssword@x.example/a');
      when = new Date('2026-01-01T00:00:00.000Z');
      tags = new Set(['a']);
      headers = new Headers({ authorization: 'Bearer abcdefghijkl', accept: 'json' });
      bytes = new Uint8Array(3);
    }
    logger.info('x', new Config());
    expect(records()[0]!.meta).toEqual([
      {
        host: 'db',
        password: '***',
        url: 'https://***@x.example/a',
        when: '2026-01-01T00:00:00.000Z',
        tags: ['a'],
        headers: { authorization: '***', accept: 'json' },
        bytes: '[Uint8Array 3 bytes]',
      },
    ]);
  });

  test('a throwing getter is reported, not thrown', () => {
    const { logger, records } = capture();
    logger.info('x', {
      get boom() {
        throw new Error('getter');
      },
    });
    expect(records()[0]).toMatchObject({ msg: 'x', boom: '[unreadable]' });
  });
});

describe('options', () => {
  test.each([
    [{ level: 'verbose' }, 'level'],
    [{ name: '' }, 'name'],
    [{ name: 3 }, 'name'],
    [{ fields: [] }, 'fields'],
    [{ fields: new Map() }, 'fields'],
    [{ write: 'stdout' }, 'write'],
    [{ fields: { toJSON: () => ({}), a: 1 } }, 'toJSON'],
  ])('rejects %p', (options, word) => {
    expect(() => new JsonLogger(options as JsonLoggerOptions)).toThrow(LoggingConfigError);
    expect(() => new JsonLogger(options as JsonLoggerOptions)).toThrow(word);
  });

  test('the default sink survives a closed stdout pipe (EPIPE)', async () => {
    const script = [
      `import { JsonLogger } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)};`,
      'const log = new JsonLogger();',
      'let n = 0;',
      'const t = setInterval(() => {',
      "  log.info('line ' + n++);",
      "  if (n > 3000) { clearInterval(t); process.stderr.write('survived'); }",
      '}, 0);',
    ].join('\n');
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const reader = proc.stdout.getReader();
    await reader.read();
    await reader.cancel();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toContain('survived');
  }, 20_000);

  test('defaults to stdout for debug/info and stderr for warn/error', () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    process.stdout.write = ((chunk: string) => out.push(chunk) > 0) as typeof stdout;
    process.stderr.write = ((chunk: string) => err.push(chunk) > 0) as typeof stderr;
    try {
      const logger = new JsonLogger({ level: 'debug' });
      logger.info('i');
      logger.error('e');
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(out[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(out[0]!).msg).toBe('i');
    expect(JSON.parse(err[0]!).msg).toBe('e');
  });
});

describe('review hardening', () => {
  test('a write returning a rejected promise is ignored', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const logger = new JsonLogger({ write: async () => Promise.reject(new Error('sink down')) });
      logger.error('x');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  test('shared references cannot make copying exponential', () => {
    const { logger, lines } = capture();
    let node: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 10; level++) {
      const parent: Record<string, unknown> = {};
      for (let key = 0; key < 10; key++) parent[`k${key}`] = node;
      node = parent;
    }
    const started = performance.now();
    logger.info('x', { graph: node }, [node]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(lines).toHaveLength(1);
  });

  test('a per-record budget caps wide graphs of shared references', () => {
    const { logger, lines } = capture();
    const level = (child: unknown) =>
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, child]));
    const graph = level(level(level({ leaf: 1 })));
    const started = performance.now();
    logger.info('x', { graph });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(lines[0]!.line).toContain('[Truncated]');
  });

  test('a huge sparse array is capped', () => {
    const { logger, lines, records } = capture();
    const sparse: unknown[] = [];
    sparse.length = 50_000_000;
    const started = performance.now();
    logger.info('x', sparse);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(lines[0]!.line.length).toBeLessThan(100_000);
    const meta = records()[0]!.meta as unknown[][];
    expect(meta[0]!.at(-1)).toBe('[49999000 more items]');
  });

  test('a wide object and a large Set are capped', () => {
    const { logger, records } = capture();
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    logger.info('x', { wide, set: new Set(Array.from({ length: 5000 }, (_, i) => i)) });
    const record = records()[0]! as { wide: Record<string, unknown>; set: unknown[] };
    expect(Object.keys(record.wide)).toHaveLength(1001);
    expect(record.wide['…']).toBe('4000 more keys omitted');
    expect(record.set).toHaveLength(1001);
  });

  test('credentials in object keys and Map keys are redacted', () => {
    const { logger, lines } = capture();
    logger.info(
      'x',
      { pools: { 'redis://admin:hunter2@db:6379': 3 } },
      new Map([['postgres://u:s3cret@h/db', 1]]),
    );
    expect(lines[0]!.line).not.toContain('hunter2');
    expect(lines[0]!.line).not.toContain('s3cret');
    expect(lines[0]!.line).toContain('redis://***@db:6379');
  });

  test('development errors redact own properties, including their keys, and every cause', () => {
    const { logger, lines, records } = capture({ development: true });
    let error = new Error('top');
    for (let i = 0; i < 20; i++) {
      error = new Error(i === 10 ? 'connect redis://admin:deepsecret@db' : `level ${i}`, {
        cause: error,
      });
    }
    Object.assign(error, { pools: { 'redis://u:keysecret@h': 1 }, password: 'pw-secret' });
    logger.error('x', error);
    const line = lines[0]!.line;
    for (const secret of ['deepsecret', 'keysecret', 'pw-secret'])
      expect(line).not.toContain(secret);
    const err = records()[0]!.err as string;
    expect(err).toContain('Caused by: … (more causes omitted)');
    expect(err).toContain('level 18');
    // No source code frames: the text is the error's own stack, not Bun.inspect output.
    expect(err).not.toMatch(/^\s*\d+ \| /m);
  });

  test('one unreadable meta item does not lose the others', () => {
    const { logger, records } = capture();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    logger.info('x', 'first', proxy, 'last');
    expect(records()[0]!.meta).toEqual(['first', '[unreadable]', 'last']);
  });

  test('an Error from another realm is recognized', async () => {
    const { runInNewContext } = await import('node:vm');
    const { logger, records } = capture({ development: false });
    logger.error('x', runInNewContext('new TypeError("other realm")'));
    expect(records()[0]!.err).toBe('TypeError: other realm');
  });

  test('child() rejects fields with toJSON', () => {
    const { logger } = capture();
    expect(() => logger.child({ toJSON: () => ({}) })).toThrow(LoggingConfigError);
  });
});

describe('childLogger()', () => {
  test('uses child() for a JsonLogger', () => {
    const { logger, records } = capture();
    const child = childLogger(logger, { job: 'report' });
    expect(child).toBeInstanceOf(JsonLogger);
    child.info('x');
    expect(records()[0]).toMatchObject({ job: 'report' });
  });

  test('passes the fields as the first meta of any other Logger, merging nested children', () => {
    const memory = new MemoryLogger();
    const child = childLogger(childLogger(memory, { a: 1, b: 1 }), { b: 2 });
    child.warn('x', 'extra');
    expect(memory.entries).toEqual([
      { level: 'warn', message: 'x', meta: [{ a: 1, b: 2 }, 'extra'] },
    ]);
  });

  test('rejects fields that are not a plain object', () => {
    expect(() => childLogger(new MemoryLogger(), new Map() as never)).toThrow(LoggingConfigError);
  });
});

describe('logError through JsonLogger', () => {
  test('in development an error that held a credential still lands in err', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ development: true, write: (line) => lines.push(line) });
    const error = Object.assign(new Error('connect redis://app:pw@cache failed'), {
      config: { headers: { authorization: 'Bearer t0ken' } },
    });
    logError({ logger, development: true }, 'Request failed', error);
    const record = JSON.parse(lines[0]!);
    expect(record.meta).toBeUndefined();
    expect(record.err).toStartWith('Error: connect redis://***@cache failed');
    expect(lines[0]).not.toContain('app:pw');
    expect(lines[0]).not.toContain('t0ken');
  });
});
