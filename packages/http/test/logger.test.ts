import { describe, expect, spyOn, test } from 'bun:test';
import {
  ConsoleLogger,
  logValue,
  MemoryLogger,
  redactCredentials,
  redactValue,
} from '../src/index.js';

test('MemoryLogger records entries per level and clears', () => {
  const logger = new MemoryLogger();
  logger.info('hello', { a: 1 });
  logger.error('bad', new Error('x'));
  expect(logger.entries.map((e) => [e.level, e.message])).toEqual([
    ['info', 'hello'],
    ['error', 'bad'],
  ]);
  expect(logger.entries[0]!.meta).toEqual([{ a: 1 }]);
  logger.clear();
  expect(logger.entries).toEqual([]);
});

describe('ConsoleLogger credential redaction', () => {
  const capture = (level: 'debug' | 'info' | 'warn' | 'error') => {
    const spy = spyOn(console, level).mockImplementation(() => {});
    return {
      calls: () => spy.mock.calls as unknown[][],
      restore: () => spy.mockRestore(),
    };
  };

  test('URL credentials in the message and in string meta are masked', () => {
    const out = capture('info');
    try {
      new ConsoleLogger().info(
        'connecting to redis://app:s3cret@db.internal:6379/0',
        'postgres://u:p@h/db',
        42,
      );
      expect(out.calls()[0]).toEqual([
        '[hpmws] connecting to redis://***@db.internal:6379/0',
        'postgres://***@h/db',
        42,
      ]);
    } finally {
      out.restore();
    }
  });

  test('Errors holding credentials print as their masked stack and causes; originals are untouched', () => {
    const out = capture('error');
    try {
      const cause = new Error('dial rediss://default:hunter2@cache:6380 failed');
      const error = new TypeError('connect amqp://guest:guest@mq failed', { cause });
      new ConsoleLogger().error('boom', error);
      const logged = out.calls()[0]![1] as string;
      expect(typeof logged).toBe('string');
      expect(logged).toStartWith('TypeError: connect amqp://***@mq failed');
      expect(logged).toContain('logger.test.ts');
      expect(logged).toContain('Caused by: Error: dial rediss://***@cache:6380 failed');
      expect(logged).not.toContain('guest:guest');
      expect(logged).not.toContain('hunter2');
      expect(error.message).toContain('guest:guest');
      expect(cause.message).toContain('hunter2');
    } finally {
      out.restore();
    }
  });

  test('values without credentials pass through unchanged', () => {
    const out = capture('warn');
    try {
      const error = new Error('plain');
      const meta = { a: 1 };
      new ConsoleLogger().warn('see https://example.com/a@b', error, meta);
      const [message, loggedError, loggedMeta] = out.calls()[0]!;
      expect(message).toBe('[hpmws] see https://example.com/a@b');
      expect(loggedError).toBe(error);
      expect(loggedMeta).toBe(meta);
    } finally {
      out.restore();
    }
  });
});

test('an Error whose only credentials are in its cause is masked too', () => {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const error = new Error('outer', { cause: new Error('mysql://root:pw@db') });
    new ConsoleLogger().error('x', error);
    const logged = spy.mock.calls[0]![1] as string;
    expect(logged).toContain('Caused by: Error: mysql://***@db');
    expect(logged).not.toContain('root:pw');
  } finally {
    spy.mockRestore();
  }
});

describe('redactCredentials', () => {
  test.each([
    ['redis://u:p@ss@h:6379', 'redis://***@h:6379'],
    ['redis://u:a/b@h/0', 'redis://***@h/0'],
    ['rediss://default:pw@cache.example:6380', 'rediss://***@cache.example:6380'],
    ['postgres://app:secret@db/app?sslmode=require', 'postgres://***@db/app?sslmode=require'],
    ['see https://example.com/path?q=1 now', 'see https://example.com/path?q=1 now'],
    ['a redis://x:y@h1 and redis://p:q@h2', 'a redis://***@h1 and redis://***@h2'],
    ['redis://admin:2024/pw@host', 'redis://***@host'],
    ['postgres://u:12/x@h/db', 'postgres://***@h/db'],
    ['https://example.com:8443/users/@alice', 'https://example.com:8443/users/@alice'],
    ['http://example.com/a@b', 'http://example.com/a@b'],
    // Credential URLs nested in an http(s) URL's path or query.
    [
      'https://api.example.com/proxy?to=redis://admin:pw@cache',
      'https://api.example.com/proxy?to=redis://***@cache',
    ],
    [
      'https://app.example/login?next=postgres://u:p@db',
      'https://app.example/login?next=postgres://***@db',
    ],
    ['https://a.example/x/https://u:p@b.example/', 'https://a.example/x/https://***@b.example/'],
    // key=value secrets and Authorization credentials.
    ['https://h/cb?code=1&token=abc.def&x=2', 'https://h/cb?code=1&token=***&x=2'],
    [
      'Server=db;User Id=sa;Password=Hunter2;Encrypt=true',
      'Server=db;User Id=sa;Password=***;Encrypt=true',
    ],
    ['host=db pwd=s3cret sslpassword=k', 'host=db pwd=*** sslpassword=***'],
    [
      '?apikey=K1&api_key=K2&secret=S&AccountKey=A==',
      '?apikey=***&api_key=***&secret=***&AccountKey=***',
    ],
    ['authorization: Bearer eyJhbGciOi.J9.x-_~+/=', 'authorization: Bearer ***'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic ***'],
    ['authorization: bearer abc.def', 'authorization: bearer ***'],
    ['AUTHORIZATION: BASIC dXNlcg==', 'AUTHORIZATION: BASIC ***'],
    // Prefixed and suffixed keys, any case.
    ['?access_token=at1&x=1', '?access_token=***&x=1'],
    ['client_secret=cs1 client_id=pub', 'client_secret=*** client_id=pub'],
    ['#id_token=eyJ.x.y&state=s', '#id_token=***&state=s'],
    ['DB_PASSWORD=hunter2 DB_HOST=db', 'DB_PASSWORD=*** DB_HOST=db'],
    ['PGPASSWORD=pg1;PGHOST=db', 'PGPASSWORD=***;PGHOST=db'],
    ['x.Refresh-Token=r1', 'x.Refresh-Token=***'],
    ['note=fine total=3', 'note=fine total=3'],
  ])('%s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });
});

describe('redactCredentials performance', () => {
  const MB = 1024 * 1024;
  test.each([
    ['a://'.repeat(MB / 4)],
    ['a.'.repeat(MB / 2)],
    [`${'a-'.repeat(MB / 2)}://`],
    [`${'a'.repeat(MB)}://x`],
    [`redis://${'u'.repeat(MB)}@h`],
    [`x://${'@'.repeat(MB)}`],
    [`${'a://'.repeat(MB / 4)}@`],
    [`${'https://a/'.repeat(MB / 10)}@`],
    ['?to=redis://u:p@h&'.repeat(MB / 18)],
    ['a='.repeat(MB / 2)],
    [`${'apikey'.repeat(MB / 6)}=`],
    ['Bearer\t'.repeat(MB / 7)],
    [`${'_a'.repeat(MB / 2)}=`],
    ['abcd='.repeat(MB / 5)],
    ['token='.repeat(MB / 6)],
    [`${'x'.repeat(MB - 1)}=`],
    ['bearer '.repeat(MB / 7)],
  ])('pathological input %#: 1 MB in well under 50 ms', (input) => {
    redactCredentials(input.slice(0, 1000)); // warm up the regex
    const started = performance.now();
    redactCredentials(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('redactValue', () => {
  test('walks plain objects, arrays and Error own properties without mutating them', () => {
    const meta = {
      url: 'redis://u:p@h',
      config: { headers: { Authorization: 'Bearer abc', Accept: 'json' } },
      list: ['postgres://a:b@db', 1],
      nested: { password: 'x', apiKey: 'y', ok: 'fine' },
    };
    const copy = structuredClone(meta);
    expect(redactValue(meta)).toEqual({
      url: 'redis://***@h',
      config: { headers: { Authorization: '***', Accept: 'json' } },
      list: ['postgres://***@db', 1],
      nested: { password: '***', apiKey: '***', ok: 'fine' },
    });
    expect(meta).toEqual(copy);
  });

  test('Error own properties and AggregateError.errors are redacted', () => {
    const error = Object.assign(new Error('request failed'), {
      url: 'https://h/x?token=t0k',
      config: { headers: { Cookie: 'sid=1' } },
    });
    const text = redactValue(error) as string;
    expect(typeof text).toBe('string');
    expect(text).toStartWith('Error: request failed');
    expect(text).toContain('token=***');
    expect(text).not.toContain('t0k');
    expect(text).not.toContain('sid=1');
    expect(error.url).toBe('https://h/x?token=t0k');
    const aggregate = new AggregateError([new Error('redis://a:b@h')], 'all failed');
    const out = redactValue(aggregate) as string;
    expect(out).toContain('redis://***@h');
    expect(out).not.toContain('a:b@');
  });

  test('cycles and depth are bounded', () => {
    const a: Record<string, unknown> = { s: 'redis://u:p@h' };
    a.self = a;
    expect(redactValue(a)).toEqual({ s: 'redis://***@h', self: '[Circular]' });
    const deep = { a: { b: { c: { d: { e: 'redis://u:p@h' } } } } };
    expect(JSON.stringify(redactValue(deep))).not.toContain('u:p@');
  });

  test('values with nothing to redact are returned as is', () => {
    const meta = { a: 1, b: ['x'] };
    const error = new Error('plain');
    expect(redactValue(meta)).toBe(meta);
    expect(redactValue(error)).toBe(error);
  });
});

describe('log injection', () => {
  test('ConsoleLogger escapes control characters in the message and string meta', () => {
    const spy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new ConsoleLogger().warn('a\r\nFAKE line\u001b[31m', 'b\nc\u007f');
      expect(spy.mock.calls[0]).toEqual(['[hpmws] a\\r\\nFAKE line\\x1b[31m', 'b\\nc\\x7f']);
    } finally {
      spy.mockRestore();
    }
  });

  test('logValue caps client values at 1024 characters and escapes them', () => {
    expect(logValue('x'.repeat(2000))).toBe(`${'x'.repeat(1024)}…`);
    expect(logValue('/a\nb')).toBe('/a\\nb');
  });
});

describe('redactValue robustness', () => {
  test('a throwing getter is recorded as [unreadable]', () => {
    const meta = {
      ok: 'redis://u:p@h',
      get boom(): string {
        throw new Error('getter');
      },
    };
    expect(redactValue(meta)).toEqual({ ok: 'redis://***@h', boom: '[unreadable]' });
  });

  test('a hostile Proxy never throws out of redactValue', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        },
        getPrototypeOf() {
          throw new Error('nope');
        },
      },
    );
    expect(() => redactValue(hostile)).not.toThrow();
    expect(() => redactValue({ nested: hostile })).not.toThrow();
  });

  test('Headers, Map and AxiosHeaders-like objects are walked', () => {
    class AxiosHeaders {
      readonly #values: Record<string, string> = { Authorization: 'Bearer t0k', Accept: 'json' };
      toJSON() {
        return { ...this.#values };
      }
    }
    const error = Object.assign(new Error('request failed'), {
      config: {
        headers: new AxiosHeaders(),
        fetchHeaders: new Headers({ authorization: 'Basic abc', 'x-ok': '1' }),
        map: new Map([['cookie', 'sid=1']]),
      },
    });
    const text = redactValue(error) as string;
    expect(text).not.toContain('t0k');
    expect(text).not.toContain('abc');
    expect(text).not.toContain('sid=1');
    expect(text).toContain('Accept');
    const plain = new Headers({ accept: 'json' });
    expect(redactValue({ plain }) as object).toEqual({ plain });
  });

  test('logging failures never escape: a throwing logger keeps the 500 response', async () => {
    const { createErrorHandler } = await import('../src/pipeline.js');
    const { makeCtx } = await import('./helpers.js');
    const broken = {
      debug() {},
      info() {},
      warn() {},
      error() {
        throw new Error('logger down');
      },
    };
    for (const development of [true, false]) {
      const res = await createErrorHandler([], broken, development)(new Error('x'), makeCtx('/p'));
      expect(res.status).toBe(500);
    }
  });
});
