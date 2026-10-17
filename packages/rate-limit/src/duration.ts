export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** The longest accepted duration: 365 days. */
export const MAX_DURATION_MS = 365 * UNITS.d;

/**
 * Whole milliseconds (rounded up, at least 1) from a number (ms) or a string such as `500ms`,
 * `15s`, `1m`, `1h`, `1d`. At most one year (`365d`).
 */
export function parseDuration(value: Duration | string): number {
  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else {
    const m = typeof value === 'string' ? /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim()) : null;
    if (!m) {
      throw new RangeError(
        `Invalid duration "${String(value)}" (use e.g. 500ms, 15s, 1m, 1h, 1d).`,
      );
    }
    ms = Number(m[1]) * UNITS[m[2] as keyof typeof UNITS];
  }
  if (!Number.isFinite(ms) || ms <= 0)
    throw new RangeError(`Invalid duration ${String(value)}: must be positive.`);
  if (ms > MAX_DURATION_MS)
    throw new RangeError(`Invalid duration ${String(value)}: must be at most one year (365d).`);
  return Math.max(1, Math.ceil(ms));
}
