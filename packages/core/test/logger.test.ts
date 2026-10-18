import { describe, expect, spyOn, test } from 'bun:test';
import { ConsoleLogger, DeferredLogger, logError, MemoryLogger } from '../src/index.js';

describe('logging in core', () => {
  test('logError logs a summary and returns a correlation id', () => {
    const logger = new MemoryLogger();
    const id = logError({ logger, development: false }, 'boom', new Error('x'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('error');
    expect(JSON.stringify(logger.entries[0])).toContain('Error: x');
  });

  test('logError writes only the summary unless development is exactly true', () => {
    for (const development of ['false', 1, 'yes']) {
      const logger = new MemoryLogger();
      const error = Object.assign(new Error('x'), { detail: 'request data' });
      logError({ logger, development: development as never }, 'boom', error);
      expect(logger.entries[0]?.meta).toEqual([]);
      expect(logger.entries[0]?.message).toEndWith(': Error: x');
    }
  });

  test('logError in development still logs an Error whose message getter throws', () => {
    const logger = new MemoryLogger();
    const error = new Error('x');
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('no message');
      },
    });
    logError({ logger, development: true }, 'boom', error);
    expect(logger.entries).toHaveLength(1);
    expect(JSON.stringify(logger.entries[0])).toContain('unloggable value');
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

describe('DeferredLogger', () => {
  const recorder = () => {
    const messages: string[] = [];
    return { messages, logger: { warn: (m: string) => messages.push(m) } };
  };

  test('holds warnings until attach(), then forwards them and later ones', () => {
    const app = recorder();
    const log = new DeferredLogger(undefined, () => {
      throw new Error('no fallback expected');
    });
    log.warn('a');
    log.warn('b');
    log.attach(app.logger);
    log.warn('c');
    expect(app.messages).toEqual(['a', 'b', 'c']);
  });

  test('an explicit target wins: attach() never replaces it', () => {
    const own = recorder();
    const app = recorder();
    const log = new DeferredLogger(own.logger, () => app.logger);
    log.warn('a');
    log.attach(app.logger);
    log.use();
    log.warn('b');
    expect([own.messages, app.messages]).toEqual([['a', 'b'], []]);
  });

  test('use() without attach() sends held warnings to the fallback; a later attach() is ignored', () => {
    const fallback = recorder();
    const app = recorder();
    const log = new DeferredLogger(undefined, () => fallback.logger);
    log.warn('a');
    log.use();
    log.attach(app.logger);
    log.warn('b');
    expect([fallback.messages, app.messages]).toEqual([['a', 'b'], []]);
  });

  test('a target that throws during attach() still receives the remaining warnings', () => {
    const received: string[] = [];
    const log = new DeferredLogger(undefined, () => ({ warn: () => {} }));
    log.warn('a');
    log.warn('b');
    log.warn('c');
    const target = {
      warn(m: string) {
        received.push(m);
        if (m === 'a') throw new Error('sink failed');
      },
    };
    expect(() => log.attach(target)).toThrow('sink failed');
    expect(received).toEqual(['a', 'b', 'c']);
  });
});
