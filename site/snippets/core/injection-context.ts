import {
  type ApplicationContext,
  InjectionToken,
  inject,
  isInInjectionContext,
  runInInjectionContext,
} from '@knead-js/core';

export interface Clock {
  now(): number;
}

export const CLOCK = new InjectionToken<Clock>('CLOCK');

// #region wrong
export class BrokenReminderService {
  remindLater(): number {
    // Throws InjectionContextError: a method runs outside the injection context.
    return inject(CLOCK).now() + 60_000;
  }
}
// #endregion wrong

// #region right
export class ReminderService {
  readonly #clock = inject(CLOCK);

  remindLater(): number {
    return this.#clock.now() + 60_000;
  }
}
// #endregion right

// #region async
export const START_TIME = new InjectionToken<number>('START_TIME');

export const startTimeProvider = {
  provide: START_TIME,
  useFactory: async () => {
    const clock = inject(CLOCK); // before the first await: works
    await Bun.sleep(1);
    // inject(CLOCK) here would throw InjectionContextError.
    return clock.now();
  },
};
// #endregion async

// #region run
/** Builds a ReminderService that is not registered as a provider, outside the container. */
export function buildReminderService(context: ApplicationContext): ReminderService {
  return runInInjectionContext(context.root.injector, () => new ReminderService());
}

export function insideInjectionContext(): boolean {
  return isInInjectionContext();
}
// #endregion run
