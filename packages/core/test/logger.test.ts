import { describe, expect, test } from 'bun:test';
import { logError, MemoryLogger } from '../src/index.js';

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
    const meta = JSON.stringify(entry.meta);
    expect(meta).toContain('postgres://***@db');
    expect(meta).toContain('***');
    expect(meta).not.toContain('app:pw');
    expect(meta).not.toContain('t0ken');
  });
});
