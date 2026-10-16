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
});
