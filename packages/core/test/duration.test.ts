import { expect, test } from 'bun:test';
import { KneadError, MAX_DURATION_MS, parseDuration } from '../src/index.js';

class CustomError extends KneadError {}

test.each([
  [250, 250],
  ['500ms', 500],
  ['15s', 15_000],
  [' 1m ', 60_000],
  ['1.5h', 5_400_000],
  ['1d', 86_400_000],
  ['365d', MAX_DURATION_MS],
  ['1.5ms', 2],
  [0.2, 1],
] as const)('parseDuration(%p) = %p', (input, ms) => {
  expect(parseDuration(input)).toBe(ms);
});

test.each([0, -1, Number.NaN, Infinity, '', '10', '1w', 'abc', '0s', '366d', null, {}, true])(
  'parseDuration(%p) throws a RangeError by default',
  (input) => {
    expect(() => parseDuration(input as never)).toThrow(RangeError);
  },
);

test('parseDuration(undefined) and parseDuration([]) throw a RangeError', () => {
  expect(() => parseDuration(undefined as never)).toThrow(RangeError);
  expect(() => parseDuration([] as never)).toThrow(RangeError);
});

test('the label names the option and the error factory picks the class', () => {
  const options = { label: 'lock TTL', error: (message: string) => new CustomError(message) };
  expect(() => parseDuration('1w', options)).toThrow(
    new CustomError('Invalid lock TTL "1w" (use e.g. 500ms, 15s, 1m, 1h, 1d).'),
  );
  expect(() => parseDuration(-1, options)).toThrow('Invalid lock TTL -1: must be positive.');
  expect(() => parseDuration('366d', options)).toThrow(
    'Invalid lock TTL 366d: must be at most one year (365d).',
  );
  expect(() => parseDuration('1w')).toThrow(
    new RangeError('Invalid duration "1w" (use e.g. 500ms, 15s, 1m, 1h, 1d).'),
  );
});

test('a long malformed string is rejected in linear time', () => {
  const input = `${'1'.repeat(100_000)}.${'1'.repeat(100_000)}x`;
  const started = performance.now();
  expect(() => parseDuration(input)).toThrow(RangeError);
  expect(performance.now() - started).toBeLessThan(50);
});
