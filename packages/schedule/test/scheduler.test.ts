import { describe, expect, mock, test } from 'bun:test';
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
  const scheduler = new Scheduler(
    {
      ...resolveScheduleOptions({}),
      onError: (error, ctx) => {
        errors.push([error, ctx]);
      },
      ...options,
    },
    clock,
  );
  return { scheduler, clock, errors };
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
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const { scheduler, clock } = setup();
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
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String((warn.mock.calls[0] as unknown[])[0])).toContain('past');
    } finally {
      console.warn = original;
    }
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
    const logged = mock(() => {});
    const original = console.error;
    console.error = logged;
    try {
      const { scheduler, clock } = setup({
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
      expect(logged).toHaveBeenCalledTimes(2);
      expect(scheduler.get('bad')!.state).toBe('scheduled');
    } finally {
      console.error = original;
    }
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

  test('gives up after shutdownTimeout and names the jobs still running', async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const { scheduler, clock } = setup({ shutdownTimeout: 1_000 });
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
      await clock.advance(999);
      expect(done).toBe(false);
      await clock.advance(1);
      await closing;
      expect(String((warn.mock.calls[0] as unknown[])[0])).toContain('stuck');
    } finally {
      console.warn = original;
    }
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
    await expect(scheduler.trigger('a')).rejects.toThrow(ScheduleConfigError);
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
});
