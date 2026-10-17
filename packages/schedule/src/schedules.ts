import { Cron } from 'croner';
import { ScheduleConfigError } from './errors.js';

export type JobKind = 'cron' | 'interval' | 'timeout';

/** @internal When a job runs, as epoch milliseconds; null means never again. */
export interface Schedule {
  readonly kind: JobKind;
  /** The first run after `now` (also used when a paused job resumes). */
  first(now: number): number | null;
  /** The run after the one scheduled at `scheduledAt`, which fired at `now`. */
  following(scheduledAt: number, now: number): number | null;
}

/**
 * The longest accepted cron pattern. Parsing is linear, but runtime patterns can come from tenant
 * data: the cap bounds the work while leaving room for any realistic pattern.
 */
export const MAX_CRON_PATTERN_LENGTH = 1024;

/** `text`, cut to `max` characters for an error message. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A value quoted in an error message, shortened. */
function quote(value: string): string {
  return JSON.stringify(clip(value, 100));
}

/** Validates the pattern and timezone eagerly; croner only computes times, it never runs jobs. */
export function cronSchedule(pattern: string, timezone?: string): Schedule {
  if (typeof pattern !== 'string') {
    throw new ScheduleConfigError(`A cron pattern must be a string, got ${typeof pattern}.`);
  }
  if (pattern.length > MAX_CRON_PATTERN_LENGTH) {
    throw new ScheduleConfigError(
      `Invalid cron pattern ${quote(pattern)}: longer than ${MAX_CRON_PATTERN_LENGTH} characters.`,
    );
  }
  let cron: Cron;
  let offset: (at: number) => number;
  try {
    cron = new Cron(pattern, { paused: true, ...(timezone === undefined ? {} : { timezone }) });
    // Invalid timezones only fail when a time is computed.
    cron.nextRun();
    offset = utcOffsetMinutes(timezone);
  } catch (error) {
    const where = timezone === undefined ? '' : ` in timezone ${quote(String(timezone))}`;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScheduleConfigError(
      `Invalid cron pattern ${quote(pattern)}${where}: ${clip(reason, 200)}`,
    );
  }
  // croner returns the first match strictly after the given time, except in the second
  // occurrence of a repeated (fall-back) hour: there it maps the wall-clock match to its first
  // occurrence, which is already past. The same wall-clock time in the current offset is the
  // real next match.
  const next = (from: number): number | null => {
    const at = cron.nextRun(new Date(from))?.getTime() ?? null;
    if (at === null || at > from) return at;
    const shifted = at + (offset(at) - offset(from)) * 60_000;
    // Never arm a time in the past: that would fire on every tick.
    return shifted > from ? shifted : null;
  };
  return {
    kind: 'cron',
    first: (now) => next(now),
    following: (scheduledAt, now) => next(Math.max(scheduledAt, now)),
  };
}

export function intervalSchedule(every: number): Schedule {
  return {
    kind: 'interval',
    first: (now) => now + every,
    following: (scheduledAt, now) =>
      scheduledAt + every > now ? scheduledAt + every : now + every,
  };
}

export function timeoutSchedule(after: number): Schedule {
  return { kind: 'timeout', first: (now) => now + after, following: () => null };
}

/** The UTC offset, in minutes, of `timezone` (default: the local zone) at an instant. */
function utcOffsetMinutes(timezone: string | undefined): (at: number) => number {
  if (timezone === undefined) return (at) => -new Date(at).getTimezoneOffset();
  // Built on first use: only a repeated (fall-back) hour needs it.
  let format: Intl.DateTimeFormat | undefined;
  return (at) => {
    format ??= new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
    const name = format.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };
}
