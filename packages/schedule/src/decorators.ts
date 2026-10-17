import { MetadataKey, readMetadata, setMetadata } from '@knead-js/core';
import { type Duration, parseDuration } from './duration.js';
import { ScheduleConfigError } from './errors.js';
import { cronSchedule, intervalSchedule, type Schedule, timeoutSchedule } from './schedules.js';

export interface JobContext {
  readonly name: string;
  /** Aborted when the application starts shutting down. */
  readonly signal: AbortSignal;
  /** The time this run was scheduled for (the trigger time for manual runs). */
  readonly scheduledAt: Date;
  readonly trigger: 'schedule' | 'manual';
}

export type JobHandler = (ctx: JobContext) => unknown;

export interface JobOptions {
  /** Unique job name. Default: `ClassName.methodName`. */
  name?: string;
}

export interface CronOptions extends JobOptions {
  /** IANA timezone the pattern is evaluated in. Default: the process timezone. */
  timezone?: string;
  /**
   * Run each firing on one instance only, using the module's `lockStore`. `true` uses the module's
   * `lockTtl`; `{ ttl }` sets this job's dedup window.
   */
  lock?: boolean | { ttl: Duration };
}

/** @internal `false`, or the TTL in ms (`undefined`: the module default). */
export type LockSetting = false | { ttl: number | undefined };

/** @internal */
export interface JobSpec {
  name: string | undefined;
  method: string | symbol;
  /** Private methods are never overridden, so a subclass's same-named one does not replace it. */
  private: boolean;
  /** The decorator metadata object of the class that declared this job. */
  owner: object;
  schedule: Schedule;
  lock: LockSetting;
  handler(instance: object): JobHandler;
}

/**
 * @internal Jobs declared on a class, including inherited ones. Re-decorating an overridden
 * method replaces the parent's jobs for it.
 */
export const JOBS = new MetadataKey<JobSpec[]>('knead:schedule:jobs');

type JobMethodDecorator = <This, Value extends (this: This, ctx: JobContext) => unknown>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>,
) => void;

/** @internal */
export function resolveName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ScheduleConfigError(`A job name must be a non-empty string, got ${String(name)}.`);
  }
  return name;
}

/** @internal */
export function resolveLock(lock: CronOptions['lock']): LockSetting {
  if (lock === undefined || lock === false) return false;
  if (lock === true) return { ttl: undefined };
  if (typeof lock === 'object' && lock !== null)
    return { ttl: parseDuration(lock.ttl, 'lock ttl') };
  throw new ScheduleConfigError(`lock must be a boolean or { ttl }, got ${String(lock)}.`);
}

function jobDecorator(
  decorator: string,
  schedule: Schedule,
  name: string | undefined,
  lock: LockSetting,
): JobMethodDecorator {
  return (_value, context) => {
    if (context.kind !== 'method' || context.static) {
      throw new ScheduleConfigError(
        `@${decorator}() can only decorate instance methods (${String(context.name)}).`,
      );
    }
    const get = context.access.get as unknown as (instance: object) => JobHandler;
    const meta = context.metadata;
    // An override that is decorated again replaces the inherited jobs of that method. A new array
    // is always written, so the parent's list is never mutated.
    const kept = (readMetadata(meta, JOBS) ?? []).filter(
      (spec) =>
        spec.owner === meta || spec.private || context.private || spec.method !== context.name,
    );
    setMetadata(meta, JOBS, [
      ...kept,
      {
        name,
        method: context.name,
        private: context.private,
        owner: meta,
        schedule,
        lock,
        handler: (instance) => {
          const method = get(instance);
          return (ctx) => method.call(instance, ctx);
        },
      },
    ]);
  };
}

/** Runs the method on a cron pattern (5 fields, or 6 with seconds first; `@daily`-style macros). */
export function Cron(pattern: string, options: CronOptions = {}): JobMethodDecorator {
  return jobDecorator(
    'Cron',
    cronSchedule(pattern, options.timezone),
    resolveName(options.name),
    resolveLock(options.lock),
  );
}

/** Runs the method every `every` (ms or a duration such as `'30s'`), first after one period. */
export function Interval(every: Duration, options: JobOptions = {}): JobMethodDecorator {
  return jobDecorator(
    'Interval',
    intervalSchedule(parseDuration(every, 'interval')),
    resolveName(options.name),
    false,
  );
}

/** Runs the method once, `after` (ms or a duration such as `'5s'`) after the application starts. */
export function Timeout(after: Duration, options: JobOptions = {}): JobMethodDecorator {
  return jobDecorator(
    'Timeout',
    timeoutSchedule(parseDuration(after, 'timeout')),
    resolveName(options.name),
    false,
  );
}
