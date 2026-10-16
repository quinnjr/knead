import { expect, test } from 'bun:test';
import { parseDuration, ScheduleConfigError } from '../src/index.js';

test.each([
  [250, 250],
  ['500ms', 500],
  ['15s', 15_000],
  ['1m', 60_000],
  ['1.5h', 5_400_000],
  ['1d', 86_400_000],
  ['365d', 365 * 86_400_000],
  [0.2, 1],
] as const)('parseDuration(%p) = %p', (input, ms) => {
  expect(parseDuration(input)).toBe(ms);
});

test.each([0, -1, Number.NaN, Infinity, '', '10', '1w', 'abc', '0s', '366d', null, {}])(
  'parseDuration(%p) throws',
  (input) => {
    expect(() => parseDuration(input as never)).toThrow(ScheduleConfigError);
  },
);
