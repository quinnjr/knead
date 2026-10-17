import { describe, expect, test } from 'bun:test';
import { errorText, isPlainObject, redactValue } from '../src/index.js';

describe('errorText', () => {
  test("is the error's stack when it holds the message", () => {
    const error = new TypeError('boom');
    expect(errorText(error)).toBe(error.stack as string);
    expect(errorText(error).startsWith('TypeError: boom')).toBe(true);
  });

  test('is `Name: message` when the stack is missing, not a string or lacks the message', () => {
    const missing = new RangeError('a');
    Object.defineProperty(missing, 'stack', { value: undefined });
    const numeric = new Error('b');
    Object.defineProperty(numeric, 'stack', { value: 42 });
    const unrelated = new Error('c');
    Object.defineProperty(unrelated, 'stack', { value: 'something else' });
    expect(errorText(missing)).toBe('RangeError: a');
    expect(errorText(numeric)).toBe('Error: b');
    expect(errorText(unrelated)).toBe('Error: c');
  });

  test('redactValue() prints an Error with a non-string stack instead of giving up', () => {
    const error = new Error('connect redis://app:hunter2@cache failed');
    Object.defineProperty(error, 'stack', { value: 42 });
    expect(redactValue(error)).toBe('Error: connect redis://***@cache failed');
  });
});

describe('isPlainObject', () => {
  test('is true only for object literals and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, 'x', 1, [], new Date(), new Map(), new (class {})()])
      expect(isPlainObject(value)).toBe(false);
  });
});
