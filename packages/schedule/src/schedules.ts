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

/** Validates the pattern and timezone eagerly; croner only computes times, it never runs jobs. */
export function cronSchedule(pattern: string, timezone?: string): Schedule {
  if (typeof pattern !== 'string') {
    throw new ScheduleConfigError(`A cron pattern must be a string, got ${typeof pattern}.`);
  }
  let cron: Cron;
  try {
    cron = new Cron(pattern, { paused: true, ...(timezone === undefined ? {} : { timezone }) });
    // Invalid timezones only fail when a time is computed.
    cron.nextRun();
  } catch (error) {
    const where = timezone === undefined ? '' : ` in timezone "${timezone}"`;
    throw new ScheduleConfigError(
      `Invalid cron pattern "${pattern}"${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // croner returns the first match strictly after the given time.
  const next = (from: number) => cron.nextRun(new Date(from))?.getTime() ?? null;
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
