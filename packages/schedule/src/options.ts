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
  /** Called with every failed run (and lock store error). Default: console.error. */
  onError?: (error: unknown, ctx: JobContext) => unknown;
  /** How long shutdown waits for runs in progress. Default 10s. */
  shutdownTimeout?: Duration;
  /** `false` registers every job paused, so nothing runs unless triggered. Default true. */
  enabled?: boolean;
}

export const SCHEDULE_OPTIONS = new InjectionToken<ScheduleModuleOptions>('SCHEDULE_OPTIONS');

/** @internal */
export interface ResolvedScheduleOptions {
  lockStore: ScheduleLockStore | undefined;
  lockTtl: number;
  onError: (error: unknown, ctx: JobContext) => unknown;
  shutdownTimeout: number;
  enabled: boolean;
}

const logError = (error: unknown, ctx: JobContext) => {
  console.error(`[knead:schedule] Job "${ctx.name}" failed:`, error);
};

/** @internal Validates options eagerly so mistakes surface at forRoot(). */
export function resolveScheduleOptions(options: ScheduleModuleOptions): ResolvedScheduleOptions {
  const { lockStore, onError, enabled } = options;
  if (lockStore !== undefined && typeof lockStore?.acquire !== 'function') {
    throw new ScheduleConfigError('lockStore must implement acquire(key, ttlMs).');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new ScheduleConfigError('onError must be a function.');
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ScheduleConfigError('enabled must be a boolean.');
  }
  return {
    lockStore,
    lockTtl: parseDuration(options.lockTtl ?? '60s', 'lockTtl'),
    onError: onError ?? logError,
    shutdownTimeout: parseDuration(options.shutdownTimeout ?? '10s', 'shutdownTimeout'),
    enabled: enabled ?? true,
  };
}
