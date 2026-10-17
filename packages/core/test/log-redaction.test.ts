import { describe, expect, test } from 'bun:test';
import { logValue, redactCredentials, redactValue, summarizeError } from '../src/index.js';

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
    ['authorization: bearer abc.def.ghi', 'authorization: bearer ***'],
    ['Authorization: Basic dXNlcjpw', 'Authorization: Basic ***'],
    ['basic user:pw', 'basic ***'],
    ['Invalid basic auth header; a basic mistake', 'Invalid basic auth header; a basic mistake'],
    ['Bearer of bad news', 'Bearer of bad news'],
    ['basic setup: done', 'basic setup: done'],
    ['Basic user:pass', 'Basic ***'],
    // Known limit: short tokens are not credential-shaped enough.
    ['Bearer abc123', 'Bearer abc123'],
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

describe('logValue', () => {
  test('logValue caps client values at 1024 characters and escapes them', () => {
    expect(logValue('x'.repeat(2000))).toBe(`${'x'.repeat(1024)}…`);
    expect(logValue('/a\nb')).toBe('/a\\nb');
  });
});

describe('summarizeError', () => {
  test('Name: message only, redacted, capped and escaped', () => {
    const error = new TypeError('connect redis://user:hunter2@cache:6379 failed\nFAKE');
    error.stack = 'secret stack';
    const summary = summarizeError(error);
    expect(summary.startsWith('TypeError: connect redis://')).toBe(true);
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('secret stack');
    expect(summary).toContain('\\nFAKE');
    expect(summarizeError(new Error('x'.repeat(600))).length).toBeLessThan(520);
    expect(summarizeError('plain')).toBe('string: plain');
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
});

test('redactValue walks own Symbol keys', () => {
  const key = Symbol('conn');
  const out = redactValue({ [key]: 'redis://u:p@h', plain: 1 }) as Record<PropertyKey, unknown>;
  expect(out[key]).toBe('redis://***@h');
  expect(out.plain).toBe(1);
  const error = Object.assign(new Error('x'), { [key]: 'postgres://a:b@db' });
  expect(redactValue(error) as string).not.toContain('a:b@');
});

describe('redactValue key rules', () => {
  test('keys containing a secret word are sensitive, whatever their case or separators', () => {
    const input = {
      db_password: 'a1',
      userPassword: 'a2',
      'x-api-key': 'a3',
      clientSecret: 'a4',
      access_token: 'a5',
      sessionId: 'a6',
      'Set-Cookie': 'a7',
      AWS_SECRET_ACCESS_KEY: 'a8',
      dbCredentials: { user: 'u', pass: 'a9' },
    };
    const out = redactValue(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) expect(out[key]).toBe('***');
  });

  test('numbers and booleans under a key that only contains a secret word are kept', () => {
    const out = redactValue({ maxTokens: 100, tokenCount: 3, hasPassword: true, note: 'x' });
    expect(out).toEqual({ maxTokens: 100, tokenCount: 3, hasPassword: true, note: 'x' });
  });

  test('an exact sensitive key is redacted whatever its value', () => {
    expect(redactValue({ token: 12345, password: false })).toEqual({
      token: '***',
      password: '***',
    });
  });

  test('credentials in object keys are redacted', () => {
    const out = redactValue({ pools: { 'redis://admin:hunter2@db:6379': 3 } });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out).toEqual({ pools: { 'redis://***@db:6379': 3 } });
  });

  test('credentials in Map keys are redacted', () => {
    const out = redactValue(new Map([['postgres://u:s3cret@h/db', 1]]));
    expect(Bun.inspect(out)).not.toContain('s3cret');
  });

  test('credentials in Error property keys are redacted', () => {
    const error = Object.assign(new Error('x'), { pools: { 'redis://u:keysecret@h': 1 } });
    expect(Bun.inspect(redactValue(error))).not.toContain('keysecret');
  });
});

describe('redactValue cause chains', () => {
  function chain(length: number, secretAt: number): Error {
    let error = new Error('root');
    for (let i = 1; i < length; i++) {
      const message = i === length - 1 - secretAt ? 'redis://admin:deepsecret@db' : `level ${i}`;
      error = new Error(message, { cause: error });
    }
    return error;
  }

  test('a credential deep in a long cause chain is redacted', () => {
    const out = redactValue(chain(20, 12));
    expect(typeof out).toBe('string');
    expect(out as string).not.toContain('deepsecret');
  });

  test('a chain longer than the scanned limit is never returned raw', () => {
    const error = chain(40, 0);
    const out = redactValue(error);
    expect(out).not.toBe(error);
    expect(out as string).toContain('Caused by: … (more causes omitted)');
    expect(out as string).not.toContain('deepsecret');
  });

  test('a short chain with nothing to redact is returned unchanged', () => {
    const error = new Error('a', { cause: new Error('b') });
    expect(redactValue(error)).toBe(error);
  });
});
