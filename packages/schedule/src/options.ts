import { InjectionToken } from '@knead-js/core';
import type { JobContext } from './decorators.js';
import { type Duration, parseDuration } from './duration.js';
import { ScheduleConfigError } from './errors.js';
import type { ScheduleLockStore } from './lock-store.js';

export interface ScheduleModuleOptions {
  /** Required by jobs with `lock`; deduplicates cron firings across instances. */
  lockStore?: ScheduleLockStore;
  /** TTL for `lock: true` jobs. Default 60s. Must exceed clock skew between instances. */
  lockTtl?: Duration;
  /** Called with every failed run (and lock store error). Default: `logger.error`. */
  onError?: (error: unknown, ctx: JobContext) => unknown;
  /** How long shutdown waits for runs in progress. Default 10s. */
  shutdownTimeout?: Duration;
  /** `false` registers every job paused, so nothing runs unless triggered. Default true. */
  enabled?: boolean;
  /**
   * Receives the scheduler's warnings and errors; `@knead-js/http`'s `Logger` (for example a
   * `ConsoleLogger`) fits. Default: console.
   */
  logger?: ScheduleLogger;
}

/** The part of a logger the scheduler uses. */
export interface ScheduleLogger {
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const SCHEDULE_OPTIONS = new InjectionToken<ScheduleModuleOptions>('SCHEDULE_OPTIONS');

/** @internal */
export interface ResolvedScheduleOptions {
  lockStore: ScheduleLockStore | undefined;
  lockTtl: number;
  onError: (error: unknown, ctx: JobContext) => unknown;
  shutdownTimeout: number;
  enabled: boolean;
  logger: ScheduleLogger;
}

/** @internal Validates options eagerly so mistakes surface at forRoot(). */
export function resolveScheduleOptions(options: ScheduleModuleOptions): ResolvedScheduleOptions {
  const { lockStore, onError, enabled, logger = console } = options;
  if (lockStore !== undefined && typeof lockStore?.acquire !== 'function') {
    throw new ScheduleConfigError('lockStore must implement acquire(key, ttlMs).');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new ScheduleConfigError('onError must be a function.');
  }
  if (typeof logger?.warn !== 'function' || typeof logger.error !== 'function') {
    throw new ScheduleConfigError('logger must implement warn() and error().');
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ScheduleConfigError('enabled must be a boolean.');
  }
  return {
    lockStore,
    lockTtl: parseDuration(options.lockTtl ?? '60s', 'lockTtl'),
    onError:
      onError ?? ((error, ctx) => logger.error(`[knead:schedule] Job "${ctx.name}" failed`, error)),
    shutdownTimeout: parseDuration(options.shutdownTimeout ?? '10s', 'shutdownTimeout'),
    enabled: enabled ?? true,
    logger,
  };
}
