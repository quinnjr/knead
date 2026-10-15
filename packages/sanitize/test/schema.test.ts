import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { sanitizedHtml } from '../src/index.js';

const str: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) =>
      typeof v === 'string' ? { value: v } : { issues: [{ message: 'Expected string' }] },
  },
};
const asyncNumber: StandardSchemaV1<unknown, number> = {
  '~standard': { version: 1, vendor: 'test', validate: async (v) => ({ value: Number(v) }) },
};

describe('sanitizedHtml', () => {
  test('sanitizes the inner output', async () => {
    const schema = sanitizedHtml(str, 'basic');
    expect(await schema['~standard'].validate('<b>x</b><script>bad()</script>')).toEqual({
      value: '<b>x</b>',
    });
    expect(schema['~standard'].vendor).toBe('hpmws');
  });

  test('passes inner issues through untouched', async () => {
    expect(await sanitizedHtml(str)['~standard'].validate(42)).toEqual({
      issues: [{ message: 'Expected string' }],
    });
  });

  test('rejects non-string inner output', async () => {
    const result = await sanitizedHtml(asyncNumber)['~standard'].validate('1');
    expect(result).toEqual({
      issues: [{ message: 'sanitizedHtml() requires the inner schema to output a string' }],
    });
  });
});
