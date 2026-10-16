import { InjectionToken } from '@knead-js/core';

/** @internal The time source and timers the scheduler uses; tests substitute a manual clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** @internal */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** @internal Overridable in tests. */
export const SCHEDULE_CLOCK = new InjectionToken<Clock>('SCHEDULE_CLOCK');
