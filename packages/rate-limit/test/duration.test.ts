import { expect, test } from 'bun:test';
import { parseDuration } from '../src/index.js';

test.each([
  [250, 250],
  ['500ms', 500],
  ['15s', 15_000],
  ['1m', 60_000],
  ['1.5h', 5_400_000],
  ['1d', 86_400_000],
  ['1.5ms', 2],
  [0.2, 1],
] as const)('parseDuration(%p) = %p', (input, ms) => {
  expect(parseDuration(input)).toBe(ms);
});

test.each([0, -1, Number.NaN, '', '10', '1w', 'abc', '0s', null, {}, true])(
  'parseDuration(%p) throws',
  (input) => {
    expect(() => parseDuration(input as never)).toThrow(RangeError);
  },
);

test('parseDuration(undefined) and parseDuration([]) throw a RangeError', () => {
  expect(() => parseDuration(undefined as never)).toThrow(RangeError);
  expect(() => parseDuration([] as never)).toThrow(RangeError);
});
