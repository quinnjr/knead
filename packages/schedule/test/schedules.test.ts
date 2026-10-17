import { describe, expect, test } from 'bun:test';
import { parseDuration, ScheduleConfigError } from '../src/index.js';
import { cronSchedule } from '../src/schedules.js';

/** Milliseconds `fn` takes, or throws with. */
function elapsed(fn: () => unknown): number {
  const started = performance.now();
  try {
    fn();
  } catch {
    // Only the time matters here.
  }
  return performance.now() - started;
}

// cronSchedule runs for runtime addCron() patterns, which can come from tenant data, and computes
// the first run eagerly: an impossible or huge pattern must not stall the event loop.
describe('cronSchedule on adversarial patterns', () => {
  // Warm croner up so the first case does not pay for JIT compilation.
  cronSchedule('0 0 * * *', 'UTC');

  test.each([
    ['30 February', '0 0 30 2 *'],
    ['31 April, with seconds', '* * * 31 4 *'],
    ['31 of every 30-day month', '0 0 31 4,6,9,11 *'],
    ['30 February in a timezone', '0 0 30 2 *'],
    ['nearest weekday to 30 February', '0 0 30W 2 *'],
    ['fifth Monday of February', '0 0 * 2 1#5'],
    ['31 February over a 7-field year range', '0 0 0 31 2 * 2026-9999'],
    [
      '31 February over a long year list',
      `0 0 0 31 2 * ${Array.from({ length: 300 }, (_, i) => 2026 + i * 25).join(',')}`,
    ],
    ['a far-future year only', '0 0 0 1 1 * 9999'],
    ['a long field list', `0 ${Array.from({ length: 300 }, (_, i) => i % 24).join(',')} * * *`],
  ])('%s is fast', (_label, pattern) => {
    expect(elapsed(() => cronSchedule(pattern, 'America/New_York'))).toBeLessThan(250);
  });

  test('a pattern longer than 1024 characters is rejected quickly', () => {
    const huge = `0 ${'1-2,'.repeat(250_000)}3 * * *`;
    expect(() => cronSchedule(huge)).toThrow(ScheduleConfigError);
    expect(() => cronSchedule(huge)).toThrow(/1024/);
    expect(elapsed(() => cronSchedule(huge))).toBeLessThan(50);
    // The cap leaves room for any realistic pattern.
    const long = `0 ${Array.from({ length: 340 }, (_, i) => i % 24).join(',')} * * *`;
    expect(long.length).toBeLessThanOrEqual(1024);
    expect(() => cronSchedule(long, 'UTC')).not.toThrow();
  });

  test.each([
    ['too long', `${'1,'.repeat(100_000)}1 * * * *`],
    ['invalid', `${'1,'.repeat(400)}x * * * *`],
  ])('the error message does not echo a %s pattern', (_label, huge) => {
    let message = '';
    try {
      cronSchedule(huge);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeLessThan(400);
  });
});

describe('parseDuration on adversarial strings', () => {
  test.each([
    ['many digits', `${'1'.repeat(100_000)}x`],
    ['a long fraction', `1.${'1'.repeat(100_000)}q`],
    ['many dots', `${'1.'.repeat(50_000)}s`],
    ['padding', `${' '.repeat(100_000)}1${' '.repeat(100_000)}s`],
  ])('%s is rejected quickly', (_label, input) => {
    expect(() => parseDuration(input as never)).toThrow(ScheduleConfigError);
    expect(elapsed(() => parseDuration(input as never))).toBeLessThan(50);
  });
});

describe('cronSchedule in a repeated (fall-back) hour', () => {
  const at = (iso: string) => Date.parse(iso);
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  test.each([
    // America/New_York, 2026-11-01: 02:00 EDT falls back to 01:00 EST (06:00Z to 07:00Z repeats).
    ['30 1 * * *', 'America/New_York', '2026-11-01T06:10:00.000Z', '2026-11-02T06:30:00.000Z'],
    ['*/15 * * * *', 'America/New_York', '2026-11-01T06:10:00.000Z', '2026-11-01T07:00:00.000Z'],
    ['0 2 * * *', 'America/New_York', '2026-11-01T06:59:59.000Z', '2026-11-01T07:00:00.000Z'],
  ])('%s in %s from %s runs next at %s', (pattern, timezone, from, expected) => {
    const schedule = cronSchedule(pattern, timezone);
    expect(iso(schedule.first(at(from)))).toBe(expected);
  });
});
