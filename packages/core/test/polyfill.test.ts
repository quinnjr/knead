import { describe, expect, test } from 'bun:test';
import '../src/polyfill.js';

describe('Symbol.metadata polyfill', () => {
  test('defines Symbol.metadata as a symbol', () => {
    expect(typeof Symbol.metadata).toBe('symbol');
  });

  test('class decorators write metadata that lands on the class', () => {
    const KEY = Symbol('key');
    const tag = (_target: Function, context: ClassDecoratorContext) => {
      context.metadata[KEY] = 'tagged';
    };
    @tag
    class Tagged {}
    expect(
      (Tagged as unknown as Record<symbol, Record<symbol, unknown>>)[Symbol.metadata]![KEY],
    ).toBe('tagged');
  });
});
