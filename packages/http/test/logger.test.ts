import { expect, test } from 'bun:test';
import { MemoryLogger } from '../src/index.js';

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
