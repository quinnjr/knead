import { describe, expect, spyOn, test } from 'bun:test';
import { ConsoleLogger, logError, MemoryLogger } from '../src/index.js';

describe('logging in core', () => {
  test('logError logs a summary and returns a correlation id', () => {
    const logger = new MemoryLogger();
    const id = logError({ logger, development: false }, 'boom', new Error('x'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('error');
    expect(JSON.stringify(logger.entries[0])).toContain('Error: x');
  });

  test('logError in development logs the full error, redacted', () => {
    const logger = new MemoryLogger();
    const error = Object.assign(new Error('connect postgres://app:pw@db failed'), {
      config: { headers: { authorization: 'Bearer t0ken' } },
    });
    logError({ logger, development: true }, 'boom', error);
    expect(logger.entries).toHaveLength(1);
    const entry = logger.entries[0]!;
    expect(entry.message).not.toContain('connect');
    expect(entry.meta).toHaveLength(1);
    // Still an Error, so loggers format it like any other error; only its text is redacted.
    const logged = entry.meta[0] as Error;
    expect(logged).toBeInstanceOf(Error);
    expect(logged.name).toBe('Error');
    expect(logged.message).toBe('connect postgres://***@db failed');
    expect(logged.stack).toStartWith('Error: connect postgres://***@db failed');
    expect(logged.stack).toContain('authorization: "***"');
    expect(Object.keys(logged)).toEqual([]);
    for (const text of [logged.message, logged.stack]) {
      expect(text).not.toContain('app:pw');
      expect(text).not.toContain('t0ken');
    }
    expect(error.message).toContain('app:pw');
  });

  test('logError in development passes an Error with nothing to redact through unchanged', () => {
    const logger = new MemoryLogger();
    const error = new TypeError('plain');
    logError({ logger, development: true }, 'boom', error);
    expect(logger.entries[0]!.meta[0]).toBe(error);
  });
});

describe('ConsoleLogger fallback when formatting fails', () => {
  test('a non-string message is still redacted', () => {
    const spy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const message = { toString: () => 'connect redis://u:secret@h failed' };
      new ConsoleLogger().info(message as unknown as string, 1);
      expect(spy.mock.calls[0]).toEqual([
        '[knead] connect redis://***@h failed',
        '[unloggable arguments]',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a message that cannot be stringified is replaced', () => {
    const spy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const message = {
        toString: () => {
          throw new Error('no');
        },
      };
      new ConsoleLogger().info(message as unknown as string);
      expect(spy.mock.calls[0]).toEqual(['[knead] [unloggable message]', '[unloggable arguments]']);
    } finally {
      spy.mockRestore();
    }
  });
});
