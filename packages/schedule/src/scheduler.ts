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
    return job && Scheduler.#info(job);
  }

  list(): JobInfo[] {
    return [...this.#jobs.values()].map((job) => Scheduler.#info(job));
  }

  /** Disarms and forgets the job; runs in progress finish and are awaited at shutdown. */
  remove(name: string): boolean {
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

  /** Re-arms from now: firings missed while paused are not run. */
  resume(name: string): void {
    this.#assertOpen();
    const job = this.#find(name);
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
      const names = [...new Set(this.#inflight.values())].map((n) => `"${n}"`).join(', ');
      console.warn(
        `[knead:schedule] Shutdown timed out after ${this.options.shutdownTimeout}ms with jobs ` +
          `still running: ${names}.`,
      );
    }
  }

  #arm(job: Job, next: number | null): void {
    this.#disarm(job);
    if (next === null) {
      job.stopped = true;
      if (job.schedule.kind === 'timeout') {
        if (this.#jobs.get(job.name) === job) this.#jobs.delete(job.name);
      } else {
        console.warn(`[knead:schedule] Job "${job.name}" has no future run and was stopped.`);
      }
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
    void this.#run(job, scheduledAt, 'schedule');
    // Arm from the schedule, not from the run's end, so slow runs do not drift it.
    this.#arm(job, job.schedule.following(scheduledAt, now));
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
        if (!acquired) return;
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
      console.error(`[knead:schedule] onError failed for job "${ctx.name}":`, handlerError);
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

  static #info(job: Job): JobInfo {
    return {
      name: job.name,
      kind: job.schedule.kind,
      state: job.stopped ? 'stopped' : job.paused ? 'paused' : 'scheduled',
      nextRunAt: job.nextAt === undefined ? undefined : new Date(job.nextAt),
      running: job.running,
    };
  }
}
