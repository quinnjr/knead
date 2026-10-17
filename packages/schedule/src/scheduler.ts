import { logValue, summarizeError } from '@knead-js/core';
import type { Clock } from './clock.js';
import type { JobContext, JobHandler, LockSetting } from './decorators.js';
import { ScheduleConfigError, ScheduleJobNotFoundError } from './errors.js';
import { assertLockTtl } from './lock-store.js';
import type { ResolvedScheduleOptions } from './options.js';
import type { JobKind, Schedule } from './schedules.js';

/** setTimeout's longest delay; longer waits re-arm in hops. */
const MAX_DELAY = 2 ** 31 - 1;

export type JobState = 'scheduled' | 'paused' | 'stopped';

export interface JobInfo {
  readonly name: string;
  readonly kind: JobKind;
  readonly state: JobState;
  /** Undefined while paused or stopped, and before the application has started. */
  readonly nextRunAt: Date | undefined;
  /** Runs in progress (runs may overlap). */
  readonly running: number;
}

/** @internal */
export interface JobDefinition {
  name: string;
  schedule: Schedule;
  handler: JobHandler;
  lock: LockSetting;
}

interface Job {
  readonly name: string;
  readonly schedule: Schedule;
  readonly handler: JobHandler;
  /** Lock TTL in ms, or undefined for unlocked jobs. */
  readonly lockTtl: number | undefined;
  paused: boolean;
  stopped: boolean;
  timer: unknown;
  nextAt: number | undefined;
  running: number;
}

/** @internal The timing engine behind SchedulerRegistry. */
export class Scheduler {
  readonly #jobs = new Map<string, Job>();
  readonly #inflight = new Map<Promise<void>, string>();
  readonly #abort = new AbortController();
  #started = false;
  #shutdown: Promise<void> | undefined;

  constructor(
    private readonly options: ResolvedScheduleOptions,
    private readonly clock: Clock,
  ) {}

  add(def: JobDefinition): void {
    this.#assertOpen();
    if (this.#jobs.has(def.name)) {
      throw new ScheduleConfigError(`A scheduled job named "${def.name}" already exists.`);
    }
    let lockTtl: number | undefined;
    if (def.lock !== false) {
      if (def.schedule.kind !== 'cron') {
        throw new ScheduleConfigError(`Job "${def.name}": only cron jobs can be locked.`);
      }
      if (!this.options.lockStore) {
        throw new ScheduleConfigError(
          `Job "${def.name}" uses lock, but ScheduleModule.forRoot() has no lockStore.`,
        );
      }
      lockTtl = def.lock.ttl ?? this.options.lockTtl;
      assertLockTtl(lockTtl);
    }
    const job: Job = {
      name: def.name,
      schedule: def.schedule,
      handler: def.handler,
      lockTtl,
      paused: !this.options.enabled,
      stopped: false,
      timer: undefined,
      nextAt: undefined,
      running: 0,
    };
    this.#jobs.set(job.name, job);
    if (this.#started && !job.paused) this.#arm(job, job.schedule.first(this.clock.now()));
  }

  /** Arms every job that is not paused. Jobs added later are armed immediately. */
  start(): void {
    if (this.#started || this.#shutdown) return;
    this.#started = true;
    for (const job of this.#jobs.values()) {
      if (!job.paused) this.#arm(job, job.schedule.first(this.clock.now()));
    }
  }

  get(name: string): JobInfo | undefined {
    const job = this.#jobs.get(name);
    return job && this.#info(job);
  }

  list(): JobInfo[] {
    return [...this.#jobs.values()].map((job) => this.#info(job));
  }

  /**
   * Disarms and forgets the job; runs in progress finish and are awaited at shutdown. Throws
   * after shutdown, like every other change.
   */
  remove(name: string): boolean {
    this.#assertOpen();
    const job = this.#jobs.get(name);
    if (!job) return false;
    this.#disarm(job);
    this.#jobs.delete(name);
    return true;
  }

  pause(name: string): void {
    this.#assertOpen();
    const job = this.#find(name);
    job.paused = true;
    this.#disarm(job);
  }

  /** Re-arms a paused or stopped job from now (missed firings are not run); otherwise a no-op. */
  resume(name: string): void {
    this.#assertOpen();
    const job = this.#find(name);
    if (!job.paused && !job.stopped) return;
    job.paused = false;
    job.stopped = false;
    if (this.#started) this.#arm(job, job.schedule.first(this.clock.now()));
  }

  /** Runs the job now, without the lock. Resolves when the run settles (errors go to onError). */
  async trigger(name: string): Promise<void> {
    this.#assertOpen();
    await this.#run(this.#find(name), this.clock.now(), 'manual');
  }

  /** Disarms everything, aborts job signals and waits up to shutdownTimeout for runs in progress. */
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#drain();
    return this.#shutdown;
  }

  async #drain(): Promise<void> {
    for (const job of this.#jobs.values()) this.#disarm(job);
    this.#abort.abort();
    if (this.#inflight.size === 0) return;
    let timer: unknown;
    const timedOut = new Promise<true>((resolve) => {
      timer = this.clock.setTimeout(() => resolve(true), this.options.shutdownTimeout);
    });
    const settled = Promise.all(this.#inflight.keys()).then(() => false as const);
    const late = await Promise.race([settled, timedOut]);
    this.clock.clearTimeout(timer);
    if (late) {
      const names = [...new Set(this.#inflight.values())].map((n) => `"${logValue(n)}"`).join(', ');
      this.options.logger.warn(
        `[knead:schedule] Shutdown timed out after ${this.options.shutdownTimeout}ms with jobs ` +
          `still running: ${names}.`,
      );
    }
  }

  #arm(job: Job, next: number | null): void {
    this.#disarm(job);
    if (next === null) {
      job.stopped = true;
      this.options.logger.warn(
        `[knead:schedule] Job "${logValue(job.name)}" has no future run and was stopped.`,
      );
      return;
    }
    job.nextAt = next;
    const delay = Math.min(Math.max(0, next - this.clock.now()), MAX_DELAY);
    job.timer = this.clock.setTimeout(() => this.#fire(job), delay);
  }

  #disarm(job: Job): void {
    if (job.timer !== undefined) this.clock.clearTimeout(job.timer);
    job.timer = undefined;
    job.nextAt = undefined;
  }

  #fire(job: Job): void {
    job.timer = undefined;
    const scheduledAt = job.nextAt!;
    const now = this.clock.now();
    // Early timer or a hop of a long delay: wait for the remainder.
    if (now < scheduledAt) {
      this.#arm(job, scheduledAt);
      return;
    }
    job.nextAt = undefined;
    if (job.schedule.kind === 'timeout') {
      // Stays listed (stopped) while it runs; leaves the registry once the run settles, unless it
      // was resumed or replaced meanwhile. Stopped before the handler starts, so a handler that
      // resumes its own job before its first await is not overridden.
      job.stopped = true;
      const run = this.#run(job, scheduledAt, 'schedule');
      void run.then(() => {
        if (job.stopped && this.#jobs.get(job.name) === job) this.#jobs.delete(job.name);
      });
      return;
    }
    void this.#run(job, scheduledAt, 'schedule');
    // The handler has already started: it may have removed, paused or re-armed this job, or shut
    // the scheduler down. Only an untouched job is armed again.
    if (!this.#isLive(job) || job.paused || job.timer !== undefined) return;
    // Arm from the schedule, not from the run's end, so slow runs do not drift it.
    this.#arm(job, job.schedule.following(scheduledAt, now));
  }

  /** Registered under its name and the scheduler is not shutting down. */
  #isLive(job: Job): boolean {
    return !this.#shutdown && this.#jobs.get(job.name) === job;
  }

  /** Never rejects: failures go to onError. */
  #run(job: Job, scheduledAt: number, trigger: JobContext['trigger']): Promise<void> {
    const ctx: JobContext = {
      name: job.name,
      signal: this.#abort.signal,
      scheduledAt: new Date(scheduledAt),
      trigger,
    };
    job.running++;
    const run = (async () => {
      if (job.lockTtl !== undefined && trigger === 'schedule') {
        let acquired: boolean;
        try {
          acquired = await this.options.lockStore!.acquire(
            `${job.name}:${scheduledAt}`,
            job.lockTtl,
          );
        } catch (error) {
          // Fail closed: without a lock the firing is skipped, never run twice.
          return this.#report(error, ctx);
        }
        // Removed, paused or shut down while the lock was pending: the firing is cancelled.
        if (!acquired || !this.#isLive(job) || job.paused) return;
      }
      try {
        await job.handler(ctx);
      } catch (error) {
        await this.#report(error, ctx);
      }
    })();
    this.#inflight.set(run, job.name);
    return run.finally(() => {
      job.running--;
      this.#inflight.delete(run);
    });
  }

  async #report(error: unknown, ctx: JobContext): Promise<void> {
    try {
      await this.options.onError(error, ctx);
    } catch (handlerError) {
      this.options.logger.error(
        `[knead:schedule] onError failed for job "${logValue(ctx.name)}": ${summarizeError(handlerError)}`,
      );
    }
  }

  #find(name: string): Job {
    const job = this.#jobs.get(name);
    if (!job) throw new ScheduleJobNotFoundError(name);
    return job;
  }

  #assertOpen(): void {
    if (this.#shutdown) throw new ScheduleConfigError('The scheduler has shut down.');
  }

  #info(job: Job): JobInfo {
    return {
      name: job.name,
      kind: job.schedule.kind,
      state: job.stopped || this.#shutdown ? 'stopped' : job.paused ? 'paused' : 'scheduled',
      nextRunAt: job.nextAt === undefined ? undefined : new Date(job.nextAt),
      running: job.running,
    };
  }
}
