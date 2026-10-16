import { describe, expect, spyOn, test } from 'bun:test';
import { ConsoleLogger, MemoryLogger, redactCredentials } from '../src/index.js';

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
  ])('pathological input %#: 1 MB in well under 50 ms', (input) => {
    redactCredentials(input.slice(0, 1000)); // warm up the regex
    const started = performance.now();
    redactCredentials(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
