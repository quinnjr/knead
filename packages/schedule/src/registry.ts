import {
  type BeforeApplicationShutdown,
  inject,
  MODULES,
  type OnApplicationBootstrap,
} from '@knead-js/core';
import { SCHEDULE_CLOCK } from './clock.js';
import { type CronOptions, type JobHandler, resolveLock, resolveName } from './decorators.js';
import { discoverJobs } from './discovery.js';
import { type Duration, parseDuration } from './duration.js';
import { ScheduleConfigError } from './errors.js';
import { resolveScheduleOptions, SCHEDULE_OPTIONS } from './options.js';
import { type JobInfo, Scheduler } from './scheduler.js';
import { cronSchedule, intervalSchedule, timeoutSchedule } from './schedules.js';

/**
 * Every scheduled job of the application. Decorated jobs are registered and started when the
 * application bootstraps; jobs can also be added, paused, resumed, triggered and removed at
 * runtime. Shutdown stops all timers and waits for runs in progress.
 */
export class SchedulerRegistry implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly #modules = inject(MODULES);
  readonly #scheduler = new Scheduler(
    resolveScheduleOptions(inject(SCHEDULE_OPTIONS)),
    inject(SCHEDULE_CLOCK),
  );

  onApplicationBootstrap(): void {
    for (const job of discoverJobs(this.#modules)) this.#scheduler.add(job);
    this.#scheduler.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.#scheduler.shutdown();
  }

  list(): JobInfo[] {
    return this.#scheduler.list();
  }

  get(name: string): JobInfo | undefined {
    return this.#scheduler.get(name);
  }

  addCron(
    name: string,
    pattern: string,
    handler: JobHandler,
    options: Omit<CronOptions, 'name'> = {},
  ): void {
    this.#scheduler.add({
      name: requireName(name),
      schedule: cronSchedule(pattern, options.timezone),
      handler: requireHandler(handler),
      lock: resolveLock(options.lock),
    });
  }

  addInterval(name: string, every: Duration, handler: JobHandler): void {
    this.#scheduler.add({
      name: requireName(name),
      schedule: intervalSchedule(parseDuration(every, 'interval')),
      handler: requireHandler(handler),
      lock: false,
    });
  }

  addTimeout(name: string, after: Duration, handler: JobHandler): void {
    this.#scheduler.add({
      name: requireName(name),
      schedule: timeoutSchedule(parseDuration(after, 'timeout')),
      handler: requireHandler(handler),
      lock: false,
    });
  }

  /** Disarms and forgets the job; runs in progress finish. False if there was no such job. */
  remove(name: string): boolean {
    return this.#scheduler.remove(name);
  }

  pause(name: string): void {
    this.#scheduler.pause(name);
  }

  /** Re-arms from now: firings missed while paused are not run. */
  resume(name: string): void {
    this.#scheduler.resume(name);
  }

  /** Runs the job now (bypassing its lock); resolves when the run settles. */
  trigger(name: string): Promise<void> {
    return this.#scheduler.trigger(name);
  }
}

function requireName(name: string): string {
  const resolved = resolveName(name);
  if (resolved === undefined) throw new ScheduleConfigError('A job name is required.');
  return resolved;
}

function requireHandler(handler: JobHandler): JobHandler {
  if (typeof handler !== 'function')
    throw new ScheduleConfigError('A job handler must be a function.');
  return handler;
}
