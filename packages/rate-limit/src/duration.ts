import { type Duration, MAX_DURATION_MS, parseDuration as parse } from '@knead-js/core';

export { type Duration, MAX_DURATION_MS };

/**
 * Whole milliseconds (rounded up, at least 1) from a number (ms) or a string such as `500ms`,
 * `15s`, `1m`, `1h`, `1d`. At most one year (`365d`).
 * @throws RangeError for anything else.
 */
export function parseDuration(value: Duration | string): number {
  return parse(value);
}
