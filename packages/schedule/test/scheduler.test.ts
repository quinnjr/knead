import { describe, expect, test } from 'bun:test';
import { MemoryLogger } from '@knead-js/core';
import type { JobContext } from '../src/decorators.js';
import { ScheduleConfigError, ScheduleJobNotFoundError } from '../src/errors.js';
import { MemoryLockStore, type ScheduleLockStore } from '../src/lock-store.js';
import { type ResolvedScheduleOptions, resolveScheduleOptions } from '../src/options.js';
import { Scheduler } from '../src/scheduler.js';
import { cronSchedule, intervalSchedule, timeoutSchedule } from '../src/schedules.js';
import { deferred, ManualClock } from './manual-clock.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function setup(options: Partial<ResolvedScheduleOptions> = {}, clock = new ManualClock(T0)) {
  const errors: [unknown, JobContext][] = [];
  // The fallback logger SchedulerRegistry passes is the application's LOGGER.
  const logger = new MemoryLogger();
  const scheduler = new Scheduler(
    {
      ...resolveScheduleOptions({}, logger),
      onError: (error, ctx) => {
        errors.push([error, ctx]);
      },
      ...options,
    },
    clock,
  );
  return { scheduler, clock, errors, logger };
}

function recorder() {
  const runs: JobContext[] = [];
  const handler = (ctx: JobContext) => {
    runs.push(ctx);
  };
  return { runs, handler };
}

const noLock = false as const;

describe('cron jobs', () => {
  test('arm for the next matching time and run with scheduledAt', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({
      name: 'hourly',
      schedule: cronSchedule('0 * * * *', 'UTC'),
      handler,
      lock: noLock,
    });
    scheduler.start();
    expect(scheduler.get('hourly')).toMatchObject({
      kind: 'cron',
      state: 'scheduled',
      nextRunAt: new Date('2026-01-01T01:00:00.000Z'),
      running: 0,
    });
    await clock.advance(3_600_000 - 1);
    expect(runs).toHaveLength(0);
    await clock.advance(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      name: 'hourly',
      trigger: 'schedule',
      scheduledAt: new Date('2026-01-01T01:00:00.000Z'),
    });
    expect(runs[0]!.signal.aborted).toBe(false);
    await clock.advance(2 * 3_600_000);
    expect(runs.map((r) => r.scheduledAt.toISOString())).toEqual([
      '2026-01-01T01:00:00.000Z',
      '2026-01-01T02:00:00.000Z',
      '2026-01-01T03:00:00.000Z',
    ]);
  });

  test('slow runs do not drift the schedule, and runs overlap', async () => {
    const { scheduler, clock } = setup();
    const gate = deferred();
    let started = 0;
    scheduler.add({
      name: 'slow',
      schedule: cronSchedule('* * * * * *', 'UTC'),
      handler: async () => {
        started++;
        await gate.promise;
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(3_000);
    expect(started).toBe(3);
    expect(scheduler.get('slow')!.running).toBe(3);
    expect(scheduler.get('slow')!.nextRunAt).toEqual(new Date(T0 + 4_000));
    gate.resolve();
    await clock.advance(0);
    expect(scheduler.get('slow')!.running).toBe(0);
  });

  test('a late timer runs once and continues from now (no catch-up)', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'm', schedule: cronSchedule('* * * * *', 'UTC'), handler, lock: noLock });
    scheduler.start();
    clock.jump(10 * 60_000 + 30_000); // suspended for 10.5 minutes
    await clock.advance(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scheduledAt).toEqual(new Date(T0 + 60_000));
    expect(scheduler.get('m')!.nextRunAt).toEqual(new Date(T0 + 11 * 60_000));
  });

  test('an early timer re-arms for the remainder instead of running', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'm', schedule: cronSchedule('* * * * *', 'UTC'), handler, lock: noLock });
    scheduler.start();
    clock.jump(59_000);
    clock.fireEarliestEarly();
    expect(runs).toHaveLength(0);
    expect(clock.delays.at(-1)).toBe(1_000);
    await clock.advance(1_000);
    expect(runs).toHaveLength(1);
  });

  test('delays beyond the timer limit are armed in hops', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    // Next 1 June: about 151 days away, more than 2^31-1 ms (24.8 days).
    scheduler.add({
      name: 'june',
      schedule: cronSchedule('0 0 1 6 *', 'UTC'),
      handler,
      lock: noLock,
    });
    scheduler.start();
    expect(clock.delays[0]).toBe(2 ** 31 - 1);
    await clock.advance(Date.parse('2026-06-01T00:00:00.000Z') - T0 - 1);
    expect(runs).toHaveLength(0);
    await clock.advance(1);
    expect(runs).toHaveLength(1);
    expect(clock.delays.every((d) => d <= 2 ** 31 - 1)).toBe(true);
  });

  test('a pattern with no future match is stopped with a warning', async () => {
    const { scheduler, clock, logger } = setup();
    const { handler } = recorder();
    scheduler.add({
      name: 'past',
      schedule: cronSchedule('0 0 0 1 1 * 2020', 'UTC'),
      handler,
      lock: noLock,
    });
    scheduler.start();
    expect(scheduler.get('past')).toMatchObject({ state: 'stopped', nextRunAt: undefined });
    expect(clock.pending).toBe(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn' });
    expect(logger.entries[0]!.message).toContain('"past"');
  });

  test('job names in warnings have control characters escaped', () => {
    const warnings: string[] = [];
    const { scheduler } = setup({ logger: { warn: (m) => warnings.push(m), error: () => {} } });
    scheduler.add({
      name: 'tenant\r\n[knead] forged',
      schedule: cronSchedule('0 0 0 1 1 * 2020', 'UTC'),
      handler: () => {},
      lock: noLock,
    });
    scheduler.start();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"tenant\\r\\n[knead] forged"');
    expect(warnings[0]).not.toMatch(/[\r\n]/);
  });

  test('timezones are honoured', () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    scheduler.add({
      name: 'ny',
      schedule: cronSchedule('0 3 * * *', 'America/New_York'),
      handler,
      lock: noLock,
    });
    scheduler.start();
    expect(scheduler.get('ny')!.nextRunAt).toEqual(new Date('2026-01-01T08:00:00.000Z'));
  });
});

describe('interval and timeout jobs', () => {
  test('intervals chain from the scheduled time', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'i', schedule: intervalSchedule(1_000), handler, lock: noLock });
    scheduler.start();
    await clock.advance(3_500);
    expect(runs.map((r) => r.scheduledAt.getTime() - T0)).toEqual([1_000, 2_000, 3_000]);
    clock.jump(10_000);
    await clock.advance(0);
    expect(runs).toHaveLength(4);
    expect(scheduler.get('i')!.nextRunAt).toEqual(new Date(T0 + 13_500 + 1_000));
  });

  test('timeouts run once and remove themselves', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 't', schedule: timeoutSchedule(500), handler, lock: noLock });
    scheduler.start();
    expect(scheduler.get('t')!.kind).toBe('timeout');
    await clock.advance(10_000);
    expect(runs).toHaveLength(1);
    expect(scheduler.get('t')).toBeUndefined();
    expect(clock.pending).toBe(0);
  });

  test('pause disarms and resume re-arms from now', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'i', schedule: intervalSchedule(1_000), handler, lock: noLock });
    scheduler.start();
    scheduler.pause('i');
    expect(scheduler.get('i')).toMatchObject({ state: 'paused', nextRunAt: undefined });
    await clock.advance(5_000);
    expect(runs).toHaveLength(0);
    scheduler.resume('i');
    expect(scheduler.get('i')!.nextRunAt).toEqual(new Date(T0 + 6_000));
    await clock.advance(1_000);
    expect(runs).toHaveLength(1);
  });
});

describe('registration', () => {
  test('jobs are not armed before start, and armed immediately after', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    expect(scheduler.get('a')).toMatchObject({ state: 'scheduled', nextRunAt: undefined });
    await clock.advance(1_000);
    expect(runs).toHaveLength(0);
    scheduler.start();
    scheduler.add({ name: 'b', schedule: intervalSchedule(100), handler, lock: noLock });
    await clock.advance(100);
    expect(runs.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  test('duplicate names are refused', () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    expect(() =>
      scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock }),
    ).toThrow(ScheduleConfigError);
  });

  test('a lock without a lock store is refused', () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    expect(() =>
      scheduler.add({
        name: 'a',
        schedule: cronSchedule('* * * * *', 'UTC'),
        handler,
        lock: { ttl: undefined },
      }),
    ).toThrow(/lockStore/);
  });

  test('enabled: false registers jobs paused; trigger still runs them', async () => {
    const { scheduler, clock } = setup({ enabled: false });
    const { runs, handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    scheduler.start();
    await clock.advance(1_000);
    expect(runs).toHaveLength(0);
    expect(scheduler.get('a')!.state).toBe('paused');
    await scheduler.trigger('a');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('manual');
  });

  test('remove disarms and reports whether the job existed', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    scheduler.start();
    expect(scheduler.remove('a')).toBe(true);
    expect(scheduler.remove('a')).toBe(false);
    await clock.advance(1_000);
    expect(runs).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  test('unknown names throw ScheduleJobNotFoundError', async () => {
    const { scheduler } = setup();
    expect(() => scheduler.pause('nope')).toThrow(ScheduleJobNotFoundError);
    expect(() => scheduler.resume('nope')).toThrow(ScheduleJobNotFoundError);
    await expect(scheduler.trigger('nope')).rejects.toThrow(ScheduleJobNotFoundError);
  });

  test('list returns every job', () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    scheduler.add({ name: 'b', schedule: timeoutSchedule(100), handler, lock: noLock });
    expect(scheduler.list().map((j) => [j.name, j.kind])).toEqual([
      ['a', 'interval'],
      ['b', 'timeout'],
    ]);
  });
});

describe('errors', () => {
  test('sync throws and rejections reach onError; the job stays armed', async () => {
    const { scheduler, clock, errors } = setup();
    let n = 0;
    scheduler.add({
      name: 'bad',
      schedule: intervalSchedule(100),
      handler: () => {
        n++;
        if (n === 1) throw new Error('sync');
        return Promise.reject(new Error('async'));
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(300);
    expect(errors.map(([e]) => (e as Error).message)).toEqual(['sync', 'async', 'async']);
    expect(errors[0]![1].name).toBe('bad');
    expect(scheduler.get('bad')!.state).toBe('scheduled');
  });

  test('a throwing onError is contained and logged', async () => {
    const { scheduler, clock, logger } = setup({
      onError: () => {
        throw new Error('handler of handlers');
      },
    });
    scheduler.add({
      name: 'bad',
      schedule: intervalSchedule(100),
      handler: () => {
        throw new Error('boom');
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(200);
    expect(logger.entries.filter((e) => e.level === 'error')).toHaveLength(2);
    expect(scheduler.get('bad')!.state).toBe('scheduled');
  });

  test('trigger resolves after the run settles, even when it fails', async () => {
    const { scheduler, errors } = setup();
    scheduler.add({
      name: 'bad',
      schedule: intervalSchedule(100),
      handler: async () => {
        throw new Error('x');
      },
      lock: noLock,
    });
    await scheduler.trigger('bad');
    expect(errors).toHaveLength(1);
    expect(errors[0]![1].trigger).toBe('manual');
  });
});

describe('locking', () => {
  test('two schedulers sharing a store run each firing once', async () => {
    const lockStore = new MemoryLockStore();
    const clock = new ManualClock(T0);
    const a = setup({ lockStore }, clock);
    const b = setup({ lockStore }, clock);
    const runs: string[] = [];
    for (const [label, { scheduler }] of [
      ['a', a],
      ['b', b],
    ] as const) {
      scheduler.add({
        name: 'job',
        schedule: cronSchedule('* * * * *', 'UTC'),
        handler: (ctx) => {
          runs.push(`${label}@${ctx.scheduledAt.getTime() - T0}`);
        },
        lock: { ttl: undefined },
      });
      scheduler.start();
    }
    await clock.advance(3 * 60_000);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.split('@')[1])).toEqual(['60000', '120000', '180000']);
  });

  test("the default lock TTL is lockTtl's default, '60s'", async () => {
    const ttls: number[] = [];
    const lockStore: ScheduleLockStore = {
      acquire: async (_key, ttl) => {
        ttls.push(ttl);
        return true;
      },
    };
    expect(resolveScheduleOptions({}, new MemoryLogger()).lockTtl).toBe(60_000);
    const { scheduler, clock } = setup({ lockStore });
    scheduler.add({
      name: 'j',
      schedule: cronSchedule('* * * * *', 'UTC'),
      handler: () => {},
      lock: { ttl: undefined },
    });
    scheduler.start();
    await clock.advance(60_000);
    expect(ttls).toEqual([60_000]);
    await scheduler.shutdown();
  });

  test('the key is the job name and scheduled time; the TTL comes from options', async () => {
    const calls: [string, number][] = [];
    const lockStore: ScheduleLockStore = {
      acquire: async (key, ttl) => {
        calls.push([key, ttl]);
        return true;
      },
    };
    const { scheduler, clock } = setup({ lockStore, lockTtl: 5_000 });
    const { handler } = recorder();
    scheduler.add({
      name: 'j',
      schedule: cronSchedule('* * * * *', 'UTC'),
      handler,
      lock: { ttl: undefined },
    });
    scheduler.add({
      name: 'k',
      schedule: cronSchedule('* * * * *', 'UTC'),
      handler,
      lock: { ttl: 9_000 },
    });
    scheduler.start();
    await clock.advance(60_000);
    expect(calls).toEqual([
      [`j:${T0 + 60_000}`, 5_000],
      [`k:${T0 + 60_000}`, 9_000],
    ]);
  });

  test('a lost lock skips the run; a lock error is reported and skips it', async () => {
    let answer: boolean | Error = false;
    const lockStore: ScheduleLockStore = {
      acquire: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const { scheduler, clock, errors } = setup({ lockStore });
    const { runs, handler } = recorder();
    scheduler.add({
      name: 'j',
      schedule: cronSchedule('* * * * *', 'UTC'),
      handler,
      lock: { ttl: undefined },
    });
    scheduler.start();
    await clock.advance(60_000);
    expect(runs).toHaveLength(0);
    answer = new Error('redis down');
    await clock.advance(60_000);
    expect(runs).toHaveLength(0);
    expect((errors[0]![0] as Error).message).toBe('redis down');
    expect(scheduler.get('j')!.state).toBe('scheduled');
  });

  test('trigger bypasses the lock', async () => {
    const lockStore: ScheduleLockStore = { acquire: async () => false };
    const { scheduler } = setup({ lockStore });
    const { runs, handler } = recorder();
    scheduler.add({
      name: 'j',
      schedule: cronSchedule('* * * * *', 'UTC'),
      handler,
      lock: { ttl: undefined },
    });
    await scheduler.trigger('j');
    expect(runs).toHaveLength(1);
  });
});

describe('shutdown', () => {
  test('disarms timers, aborts the signal and waits for runs in progress', async () => {
    const { scheduler, clock } = setup();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    let finished = false;
    scheduler.add({
      name: 'slow',
      schedule: intervalSchedule(100),
      handler: async (ctx) => {
        signal = ctx.signal;
        await gate.promise;
        finished = true;
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    let done = false;
    const closing = scheduler.shutdown().then(() => {
      done = true;
    });
    await clock.advance(0);
    expect(signal!.aborted).toBe(true);
    expect(done).toBe(false);
    gate.resolve();
    await closing;
    expect(finished).toBe(true);
    expect(clock.pending).toBe(0);
  });

  test("shutdownTimeout defaults to '10s'", async () => {
    expect(resolveScheduleOptions({}, new MemoryLogger()).shutdownTimeout).toBe(10_000);
    const { scheduler, clock, logger } = setup();
    scheduler.add({
      name: 'stuck',
      schedule: intervalSchedule(100),
      handler: () => new Promise(() => {}),
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    let done = false;
    const closing = scheduler.shutdown().then(() => {
      done = true;
    });
    await clock.advance(9_999);
    expect(done).toBe(false);
    expect(logger.entries).toEqual([]);
    await clock.advance(1);
    await closing;
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe('warn');
  });

  test('gives up after shutdownTimeout and names the jobs still running', async () => {
    const { scheduler, clock, logger } = setup({ shutdownTimeout: 1_000 });
    scheduler.add({
      name: 'stuck\nline',
      schedule: intervalSchedule(100),
      handler: () => new Promise(() => {}),
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    let done = false;
    const closing = scheduler.shutdown().then(() => {
      done = true;
    });
    await clock.advance(999);
    expect(done).toBe(false);
    await clock.advance(1);
    await closing;
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe('warn');
    expect(logger.entries[0]!.message).toContain('"stuck\\nline"');
  });

  test('a removed job that is still running is awaited', async () => {
    const { scheduler, clock } = setup();
    const gate = deferred();
    scheduler.add({
      name: 'slow',
      schedule: timeoutSchedule(100),
      handler: () => gate.promise,
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    expect(scheduler.remove('slow')).toBe(true);
    let done = false;
    const closing = scheduler.shutdown().then(() => {
      done = true;
    });
    await clock.advance(0);
    expect(done).toBe(false);
    gate.resolve();
    await closing;
  });

  test('after shutdown, changes are refused and shutdown is idempotent', async () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    const first = scheduler.shutdown();
    expect(scheduler.shutdown()).toBe(first);
    await first;
    expect(() =>
      scheduler.add({ name: 'b', schedule: intervalSchedule(100), handler, lock: noLock }),
    ).toThrow(ScheduleConfigError);
    expect(() => scheduler.pause('a')).toThrow(ScheduleConfigError);
    expect(() => scheduler.resume('a')).toThrow(ScheduleConfigError);
    expect(() => scheduler.remove('a')).toThrow(ScheduleConfigError);
    expect(() => scheduler.remove('missing')).toThrow(ScheduleConfigError);
    await expect(scheduler.trigger('a')).rejects.toThrow(ScheduleConfigError);
  });

  test('an abort listener cannot add or resume jobs while the scheduler shuts down', async () => {
    const { scheduler, clock } = setup();
    const { handler } = recorder();
    const gate = deferred();
    const refused: unknown[] = [];
    scheduler.add({ name: 'idle', schedule: intervalSchedule(100), handler, lock: noLock });
    scheduler.pause('idle');
    scheduler.add({
      name: 'slow',
      schedule: timeoutSchedule(100),
      handler: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          for (const change of [
            () =>
              scheduler.add({ name: 'late', schedule: timeoutSchedule(50), handler, lock: noLock }),
            () => scheduler.resume('idle'),
          ]) {
            try {
              change();
            } catch (error) {
              refused.push(error);
            }
          }
        });
        await gate.promise;
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    const closing = scheduler.shutdown();
    expect(refused).toHaveLength(2);
    for (const error of refused) expect(error).toBeInstanceOf(ScheduleConfigError);
    expect(scheduler.get('late')).toBeUndefined();
    expect(scheduler.get('idle')!.nextRunAt).toBeUndefined();
    // Only the shutdownTimeout timer is armed.
    expect(clock.pending).toBe(1);
    gate.resolve();
    await closing;
    expect(clock.pending).toBe(0);
  });
});

describe('review regressions', () => {
  test('a handler that removes its own job is not re-armed', async () => {
    const { scheduler, clock } = setup();
    let runs = 0;
    scheduler.add({
      name: 'self',
      schedule: intervalSchedule(100),
      handler: () => {
        runs++;
        scheduler.remove('self');
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(500);
    expect(runs).toBe(1);
    expect(clock.pending).toBe(0);
  });

  test('a handler that pauses its own job is not re-armed', async () => {
    const { scheduler, clock } = setup();
    let runs = 0;
    scheduler.add({
      name: 'self',
      schedule: intervalSchedule(100),
      handler: () => {
        runs++;
        scheduler.pause('self');
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(500);
    expect(runs).toBe(1);
    expect(scheduler.get('self')).toMatchObject({ state: 'paused', nextRunAt: undefined });
    expect(clock.pending).toBe(0);
  });

  test('a handler that shuts the scheduler down leaves no timer behind', async () => {
    const { scheduler, clock } = setup();
    let runs = 0;
    scheduler.add({
      name: 'self',
      schedule: intervalSchedule(100),
      handler: () => {
        runs++;
        void scheduler.shutdown();
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(500);
    expect(runs).toBe(1);
    expect(clock.pending).toBe(0);
  });

  test('a handler that replaces its own job leaves only the new one armed', async () => {
    const { scheduler, clock } = setup();
    const runs: string[] = [];
    scheduler.add({
      name: 'job',
      schedule: intervalSchedule(100),
      handler: () => {
        runs.push('old');
        scheduler.remove('job');
        scheduler.add({
          name: 'job',
          schedule: intervalSchedule(1_000),
          handler: () => {
            runs.push('new');
          },
          lock: noLock,
        });
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(1_100);
    expect(runs).toEqual(['old', 'new']);
    expect(clock.pending).toBe(1);
  });

  test('a handler that resumes its own job keeps a single timer', async () => {
    const { scheduler, clock } = setup();
    let runs = 0;
    scheduler.add({
      name: 'self',
      schedule: intervalSchedule(100),
      handler: () => {
        runs++;
        if (runs === 1) {
          scheduler.pause('self');
          scheduler.resume('self');
        }
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(300);
    expect(runs).toBe(3);
    expect(clock.pending).toBe(1);
  });

  test('resume is a no-op for a job that is not paused or stopped', async () => {
    const { scheduler, clock } = setup();
    const { runs, handler } = recorder();
    scheduler.add({ name: 't', schedule: timeoutSchedule(1_000), handler, lock: noLock });
    scheduler.start();
    await clock.advance(900);
    scheduler.resume('t');
    await clock.advance(100);
    expect(runs).toHaveLength(1);
  });

  test('a timeout is visible as stopped while its run is in progress, then removed', async () => {
    const { scheduler, clock } = setup();
    const gate = deferred();
    scheduler.add({
      name: 't',
      schedule: timeoutSchedule(100),
      handler: () => gate.promise,
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    expect(scheduler.get('t')).toMatchObject({
      state: 'stopped',
      running: 1,
      nextRunAt: undefined,
    });
    gate.resolve();
    await clock.advance(0);
    expect(scheduler.get('t')).toBeUndefined();
  });

  test('resuming a timeout while it runs re-arms it and keeps it registered', async () => {
    const { scheduler, clock } = setup();
    const gate = deferred();
    let runs = 0;
    scheduler.add({
      name: 't',
      schedule: timeoutSchedule(100),
      handler: () => {
        runs++;
        return runs === 1 ? gate.promise : undefined;
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    scheduler.resume('t');
    gate.resolve();
    await clock.advance(100);
    expect(runs).toBe(2);
  });

  test('a timeout handler that resumes itself before its first await is re-armed', async () => {
    const { scheduler, clock } = setup();
    let runs = 0;
    scheduler.add({
      name: 't',
      schedule: timeoutSchedule(100),
      handler: async () => {
        runs++;
        if (runs === 1) scheduler.resume('t');
        await Promise.resolve();
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    expect(runs).toBe(1);
    expect(scheduler.get('t')).toMatchObject({ state: 'scheduled' });
    await clock.advance(100);
    expect(runs).toBe(2);
    expect(scheduler.get('t')).toBeUndefined();
  });

  test('every job reports stopped after shutdown', async () => {
    const { scheduler } = setup();
    const { handler } = recorder();
    scheduler.add({ name: 'a', schedule: intervalSchedule(100), handler, lock: noLock });
    scheduler.start();
    await scheduler.shutdown();
    expect(scheduler.get('a')).toMatchObject({ state: 'stopped', nextRunAt: undefined });
  });

  for (const [label, act] of [
    ['shutdown', (s: Scheduler) => void s.shutdown()],
    ['remove', (s: Scheduler) => void s.remove('j')],
    ['pause', (s: Scheduler) => s.pause('j')],
  ] as const) {
    test(`${label} while the lock is being acquired cancels the run`, async () => {
      const acquired = deferred<boolean>();
      const lockStore: ScheduleLockStore = { acquire: () => acquired.promise };
      const { scheduler, clock } = setup({ lockStore });
      const { runs, handler } = recorder();
      scheduler.add({
        name: 'j',
        schedule: cronSchedule('* * * * *', 'UTC'),
        handler,
        lock: { ttl: undefined },
      });
      scheduler.start();
      await clock.advance(60_000);
      act(scheduler);
      acquired.resolve(true);
      await clock.advance(0);
      expect(runs).toHaveLength(0);
    });
  }

  test('warnings go to the configured logger', async () => {
    const warnings: string[] = [];
    const { scheduler } = setup({ logger: { warn: (m) => warnings.push(m), error: () => {} } });
    scheduler.add({
      name: 'past',
      schedule: cronSchedule('0 0 0 1 1 * 2020', 'UTC'),
      handler: () => {},
      lock: noLock,
    });
    scheduler.start();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"past"');
  });

  test('a throwing onError is logged as a redacted summary', async () => {
    const errors: unknown[][] = [];
    const { scheduler, clock } = setup({
      onError: () => {
        throw new Error('token=abc123 rejected');
      },
      logger: { warn: () => {}, error: (...args) => errors.push(args) },
    });
    scheduler.add({
      name: 'bad',
      schedule: intervalSchedule(100),
      handler: () => {
        throw new Error('boom');
      },
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    expect(String(errors[0]![0])).toContain('onError failed for job "bad"');
    expect(String(errors[0]![0])).not.toContain('abc123');
  });
});

describe('daylight saving time', () => {
  const NY = 'America/New_York';

  test('spring forward: a job in the skipped hour runs an hour later, once', async () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist that day.
    const { scheduler, clock } = setup({}, new ManualClock('2026-03-07T12:00:00.000Z'));
    const { runs, handler } = recorder();
    scheduler.add({
      name: 'nightly',
      schedule: cronSchedule('30 2 * * *', NY),
      handler,
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(3 * 86_400_000);
    expect(runs.map((r) => r.scheduledAt.toISOString())).toEqual([
      '2026-03-08T07:30:00.000Z', // 03:30 EDT
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  test('fall back: a job in the repeated hour runs once, in its first occurrence', async () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
    const { scheduler, clock } = setup({}, new ManualClock('2026-10-31T12:00:00.000Z'));
    const { runs, handler } = recorder();
    scheduler.add({
      name: 'early',
      schedule: cronSchedule('30 1 * * *', NY),
      handler,
      lock: noLock,
    });
    scheduler.add({
      name: 'nightly',
      schedule: cronSchedule('30 2 * * *', NY),
      handler,
      lock: noLock,
    });
    scheduler.start();
    await clock.advance(2 * 86_400_000);
    expect(runs.map((r) => `${r.name} ${r.scheduledAt.toISOString()}`)).toEqual([
      'early 2026-11-01T05:30:00.000Z', // 01:30 EDT; 01:30 EST is skipped
      'nightly 2026-11-01T07:30:00.000Z', // 02:30 EST
      'early 2026-11-02T06:30:00.000Z',
      'nightly 2026-11-02T07:30:00.000Z',
    ]);
  });

  test('fall back: a job armed inside the repeated hour never fires in the past', async () => {
    // 06:00Z is 01:00 EST, the second 01:00 of the day. croner answers nextRun() there with the
    // first occurrence (05:xx Z), which is already past: armed as is, the job would fire on every
    // tick until 07:00Z.
    const { scheduler, clock } = setup({}, new ManualClock('2026-11-01T06:00:00.000Z'));
    const { runs, handler } = recorder();
    scheduler.add({ name: 'q', schedule: cronSchedule('*/15 * * * *', NY), handler, lock: noLock });
    scheduler.add({
      name: 'early',
      schedule: cronSchedule('30 1 * * *', NY),
      handler,
      lock: noLock,
    });
    scheduler.start();
    for (const job of ['q', 'early']) {
      expect(scheduler.get(job)!.nextRunAt!.getTime()).toBeGreaterThan(clock.now());
    }
    // Times in the repeated hour already ran in its first occurrence: the second one is skipped,
    // as it is for an instance that was running through the first.
    expect(scheduler.get('q')!.nextRunAt).toEqual(new Date('2026-11-01T07:00:00.000Z'));
    expect(scheduler.get('early')!.nextRunAt).toEqual(new Date('2026-11-02T06:30:00.000Z'));
    await clock.advance(3_600_000);
    const times = runs.map((r) => `${r.name} ${r.scheduledAt.toISOString()}`);
    expect(times).toEqual([
      'q 2026-11-01T07:00:00.000Z', // 02:00 EST
    ]);
  });

  test('fall back: an instance started inside the repeated hour does not repeat a locked run', async () => {
    const lockStore = new MemoryLockStore();
    const a = setup({ lockStore }, new ManualClock('2026-10-31T12:00:00.000Z'));
    // Starts at 01:00 EST, after `a` ran the 01:30 EDT firing.
    const b = setup({ lockStore }, new ManualClock('2026-11-01T06:00:00.000Z'));
    const runs: string[] = [];
    for (const [label, { scheduler }] of [
      ['a', a],
      ['b', b],
    ] as const) {
      scheduler.add({
        name: 'early',
        schedule: cronSchedule('30 1 * * *', NY),
        handler: (ctx) => {
          runs.push(`${label} ${ctx.scheduledAt.toISOString()}`);
        },
        lock: { ttl: undefined },
      });
    }
    a.scheduler.start();
    await a.clock.advance(18 * 3_600_000); // to 2026-11-01T06:00Z
    b.scheduler.start();
    await b.clock.advance(3_600_000);
    expect(runs).toEqual(['a 2026-11-01T05:30:00.000Z']);
    await a.clock.advance(86_400_000);
    await b.clock.advance(86_400_000);
    expect(runs.map((r) => r.slice(2))).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });
});
