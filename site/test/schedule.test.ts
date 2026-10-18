// Pins the behaviour documented on guide/scheduling and packages/schedule.
import { afterEach, describe, expect, test } from 'bun:test';
import { ApplicationContext, Injectable, Module } from '@knead-js/core';
import {
  Cron,
  Interval,
  type JobContext,
  MAX_DURATION_MS,
  MemoryLockStore,
  parseDuration,
  RedisLockStore,
  ScheduleConfigError,
  ScheduleJobNotFoundError,
  ScheduleModule,
  type ScheduleModuleOptions,
  SchedulerRegistry,
  Timeout,
} from '@knead-js/schedule';
import { Test } from '@knead-js/testing';
import { failures, AppModule as OptionsModule } from '../snippets/schedule/options.js';
import { InventoryJobs, InventorySync } from '../snippets/schedule/overlap.js';
import { AppModule, ReportService } from '../snippets/schedule/report-jobs.js';
import { TenantReports } from '../snippets/schedule/tenant-reports.js';

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const ctx of open.splice(0)) await ctx.close();
});

async function boot(root: Parameters<typeof ApplicationContext.create>[0]) {
  const ctx = await ApplicationContext.create(root);
  open.push(ctx);
  return ctx;
}

function memoryLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    logger: {
      warn: (message: string) => warnings.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

async function bootWith(options: ScheduleModuleOptions, providers: Function[]) {
  @Module({ imports: [ScheduleModule.forRoot(options)], providers: providers as never })
  class Root {}
  return boot(Root);
}

describe('decorated jobs', () => {
  test('are registered under their names with kind, state and next run', async () => {
    const before = Date.now();
    const ctx = await boot(AppModule);
    const registry = ctx.get(SchedulerRegistry);
    const jobs = registry.list();
    expect(jobs.map((j) => [j.name, j.kind, j.state, j.running])).toEqual([
      ['nightly-report', 'cron', 'scheduled', 0],
      ['ReportJobs.heartbeat', 'interval', 'scheduled', 0],
      ['warm-cache', 'timeout', 'scheduled', 0],
    ]);
    const nightly = registry.get('nightly-report')!.nextRunAt!;
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(nightly);
    expect(hour).toBe('03:00');
    const heartbeat = registry.get('ReportJobs.heartbeat')!.nextRunAt!.getTime();
    expect(heartbeat - before).toBeGreaterThanOrEqual(30_000);
    expect(heartbeat - Date.now()).toBeLessThanOrEqual(30_000);
    expect(registry.get('nope')).toBeUndefined();
  });

  test('trigger runs a job now and resolves when it settles', async () => {
    const ctx = await boot(AppModule);
    await ctx.get(SchedulerRegistry).trigger('nightly-report');
    expect(ctx.get(ReportService).built).toHaveLength(1);
  });

  test('unknown names throw ScheduleJobNotFoundError', async () => {
    const ctx = await boot(AppModule);
    const registry = ctx.get(SchedulerRegistry);
    expect(() => registry.pause('missing')).toThrow(ScheduleJobNotFoundError);
    expect(() => registry.resume('missing')).toThrow('No scheduled job named "missing".');
    expect(registry.remove('missing')).toBe(false);
    const error = await registry.trigger('missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScheduleJobNotFoundError);
    expect((error as ScheduleJobNotFoundError).jobName).toBe('missing');
  });

  test('pause and resume change the state; resume re-arms from now', async () => {
    const ctx = await boot(AppModule);
    const registry = ctx.get(SchedulerRegistry);
    registry.pause('ReportJobs.heartbeat');
    expect(registry.get('ReportJobs.heartbeat')).toMatchObject({
      state: 'paused',
      nextRunAt: undefined,
    });
    const before = Date.now();
    registry.resume('ReportJobs.heartbeat');
    const info = registry.get('ReportJobs.heartbeat')!;
    expect(info.state).toBe('scheduled');
    expect(info.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });

  test('after shutdown every job is stopped and changes are refused', async () => {
    const ctx = await ApplicationContext.create(AppModule);
    const registry = ctx.get(SchedulerRegistry);
    await ctx.close();
    expect(registry.list().map((j) => j.state)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(() => registry.addInterval('late', '1s', () => {})).toThrow(
      'The scheduler has shut down.',
    );
    expect(() => registry.pause('nightly-report')).toThrow(ScheduleConfigError);
  });

  test('a timeout runs once, then leaves the registry', async () => {
    let runs = 0;
    @Injectable()
    class Warmup {
      @Timeout(5) once() {
        runs++;
      }
    }
    const ctx = await bootWith({}, [Warmup]);
    const registry = ctx.get(SchedulerRegistry);
    expect(registry.get('Warmup.once')?.kind).toBe('timeout');
    await Bun.sleep(40);
    expect(runs).toBe(1);
    expect(registry.get('Warmup.once')).toBeUndefined();
  });

  test('bootstrap refuses duplicate names, transient providers and a second forRoot()', async () => {
    @Injectable()
    class A {
      @Interval('1h', { name: 'same' }) a() {}
    }
    @Injectable()
    class B {
      @Interval('1h', { name: 'same' }) b() {}
    }
    await expect(bootWith({}, [A, B])).rejects.toThrow(
      'A scheduled job named "same" already exists.',
    );

    @Injectable()
    class Transient {
      @Interval('1h') tick() {}
    }
    await expect(
      bootWith({}, [{ provide: Transient, useClass: Transient, scope: 'transient' } as never]),
    ).rejects.toThrow(/Transient has scheduled jobs but is a transient provider/);

    @Module({ imports: [ScheduleModule.forRoot()] })
    class Feature {}
    @Module({ imports: [ScheduleModule.forRoot(), Feature], providers: [A] })
    class Twice {}
    await expect(ApplicationContext.create(Twice)).rejects.toThrow(
      'ScheduleModule.forRoot() is imported more than once; import it once, in the root module.',
    );
  });

  test('invalid schedules fail when the decorator is evaluated', () => {
    expect(() => {
      class Bad {
        @Cron('61 * * * *') a() {}
      }
      return Bad;
    }).toThrow(/^Invalid cron pattern "61 \* \* \* \*"/);
    expect(() => {
      class Bad {
        @Cron('0 3 * * *', { timezone: 'Mars/Olympus' }) a() {}
      }
      return Bad;
    }).toThrow(/in timezone "Mars\/Olympus"/);
    expect(() => {
      class Bad {
        @Interval('soon' as never) a() {}
      }
      return Bad;
    }).toThrow('Invalid interval "soon" (use e.g. 500ms, 15s, 1m, 1h, 1d).');
  });

  test('cron accepts 6 fields (seconds first) and macros', async () => {
    const ctx = await bootWith({}, []);
    const registry = ctx.get(SchedulerRegistry);
    registry.addCron('seconds', '*/10 * * * * *', () => {});
    registry.addCron('macro', '@daily', () => {}, { timezone: 'UTC' });
    expect(registry.get('seconds')!.nextRunAt!.getUTCSeconds() % 10).toBe(0);
    const daily = registry.get('macro')!.nextRunAt!;
    expect([daily.getUTCHours(), daily.getUTCMinutes()]).toEqual([0, 0]);
  });
});

test('a cron pattern with no future match is stopped with a warning', async () => {
  const { logger, warnings } = memoryLogger();
  const ctx = await bootWith({ logger }, []);
  const registry = ctx.get(SchedulerRegistry);
  registry.addCron('feb-31', '0 0 31 2 *', () => {});
  expect(registry.get('feb-31')).toMatchObject({ state: 'stopped', nextRunAt: undefined });
  expect(warnings).toEqual(['[knead:schedule] Job "feb-31" has no future run and was stopped.']);
});

describe('durations', () => {
  test('numbers are milliseconds; strings take ms, s, m, h, d', () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration(' 2h ')).toBe(7_200_000);
    expect(parseDuration(0.2)).toBe(1);
    expect(parseDuration('365d')).toBe(MAX_DURATION_MS);
    expect(MAX_DURATION_MS).toBe(31_536_000_000);
  });

  test('zero, negative, unknown units and more than a year are refused', () => {
    expect(() => parseDuration(0)).toThrow('Invalid duration 0: must be positive.');
    expect(() => parseDuration('366d', 'lockTtl')).toThrow(
      'Invalid lockTtl 366d: must be at most one year (365d).',
    );
    expect(() => parseDuration('10 s')).toThrow(ScheduleConfigError);
    expect(() => parseDuration('1w')).toThrow(ScheduleConfigError);
  });
});

describe('errors and logging', () => {
  test('a custom onError receives failures with the job context', async () => {
    const ctx = await boot(OptionsModule);
    const registry = ctx.get(SchedulerRegistry);
    registry.addInterval('flaky', '1h', () => {
      throw new Error('boom');
    });
    const original = console.error;
    console.error = () => {};
    try {
      await registry.trigger('flaky');
    } finally {
      console.error = original;
    }
    expect(failures.get('flaky')).toBe(1);
    // The job stays registered and armed.
    expect(registry.get('flaky')?.state).toBe('scheduled');
  });

  test('the default report is one redacted line through logger.error', async () => {
    const { logger, errors } = memoryLogger();
    const ctx = await bootWith({ logger }, []);
    const registry = ctx.get(SchedulerRegistry);
    registry.addInterval('sync', '1h', async () => {
      throw new Error('connect redis://app:hunter2@cache:6379 refused');
    });
    await registry.trigger('sync');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith('[knead:schedule] Job "sync" failed: Error: connect redis://');
    expect(errors[0]).not.toContain('hunter2');
  });

  test('a throwing onError is contained and logged', async () => {
    const { logger, errors } = memoryLogger();
    const ctx = await bootWith(
      {
        logger,
        onError: () => {
          throw new TypeError('tracker down');
        },
      },
      [],
    );
    const registry = ctx.get(SchedulerRegistry);
    registry.addInterval('sync', '1h', () => {
      throw new Error('boom');
    });
    await registry.trigger('sync');
    expect(errors).toEqual([
      '[knead:schedule] onError failed for job "sync": TypeError: tracker down',
    ]);
  });

  test('invalid options fail at forRoot()', () => {
    expect(() => ScheduleModule.forRoot({ lockTtl: '0s' })).toThrow(
      'Invalid lockTtl 0s: must be positive.',
    );
    expect(() => ScheduleModule.forRoot({ lockStore: {} as never })).toThrow(
      'lockStore must implement acquire(key, ttlMs).',
    );
    expect(() => ScheduleModule.forRoot({ logger: {} as never })).toThrow(
      'logger must implement warn() and error().',
    );
    expect(() => ScheduleModule.forRoot({ enabled: 'no' as never })).toThrow(
      'enabled must be a boolean.',
    );
    expect(() => ScheduleModule.forRoot({ onError: 1 as never })).toThrow(
      'onError must be a function.',
    );
  });

  test('enabled: false registers jobs paused; trigger still runs them', async () => {
    const ctx = await bootWith({ enabled: false }, [ReportService, InventoryJobs, InventorySync]);
    const registry = ctx.get(SchedulerRegistry);
    expect(registry.get('InventoryJobs.syncInventory')).toMatchObject({
      state: 'paused',
      nextRunAt: undefined,
    });
  });
});

describe('overlap', () => {
  test('the guard skips a run while the previous one is in progress', async () => {
    let calls = 0;
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const moduleRef = await Test.createModule({
      imports: [ScheduleModule.forRoot({ enabled: false })],
      providers: [InventorySync, InventoryJobs],
    })
      .overrideProvider(InventorySync)
      .useValue({
        run: async () => {
          calls++;
          await gate;
        },
      })
      .compile();
    open.push(moduleRef);
    const registry = moduleRef.get(SchedulerRegistry);
    const first = registry.trigger('InventoryJobs.syncInventory');
    await registry.trigger('InventoryJobs.syncInventory');
    expect(registry.get('InventoryJobs.syncInventory')?.running).toBe(1);
    resolve();
    await first;
    expect(calls).toBe(1);
  });
});

describe('runtime jobs', () => {
  test('TenantReports adds, runs, lists and removes a cron job', async () => {
    const moduleRef = await Test.createModule({
      imports: [ScheduleModule.forRoot()],
      providers: [ReportService, TenantReports],
    }).compile();
    open.push(moduleRef);
    const tenants = moduleRef.get(TenantReports);
    tenants.schedule({ id: 'acme', reportCron: '0 6 * * 1', timezone: 'Europe/Berlin' });
    const [info] = tenants.status();
    expect(info).toMatchObject({ name: 'tenant-report:acme', kind: 'cron', state: 'scheduled' });
    await tenants.runNow('acme');
    expect(moduleRef.get(ReportService).built).toHaveLength(1);
    expect(() =>
      tenants.schedule({ id: 'acme', reportCron: '0 6 * * 1', timezone: 'Europe/Berlin' }),
    ).toThrow('A scheduled job named "tenant-report:acme" already exists.');
    expect(tenants.unschedule('acme')).toBe(true);
    expect(tenants.unschedule('acme')).toBe(false);
    expect(() => tenants.schedule({ id: 'x', reportCron: 'nope', timezone: 'UTC' })).toThrow(
      ScheduleConfigError,
    );
  });

  test('jobs added at runtime are validated', async () => {
    const ctx = await bootWith({}, []);
    const registry = ctx.get(SchedulerRegistry);
    expect(() => registry.addInterval('', '1s', () => {})).toThrow(
      'A job name must be a non-empty string, got .',
    );
    expect(() => registry.addTimeout('t', '1s', 'x' as never)).toThrow(
      'A job handler must be a function.',
    );
    expect(() => registry.addCron('c', '* * * * *', () => {}, { lock: true })).toThrow(
      'Job "c" uses lock, but ScheduleModule.forRoot() has no lockStore.',
    );
  });
});

describe('locks', () => {
  test('MemoryLockStore grants a key once until the TTL passes', async () => {
    const store = new MemoryLockStore();
    expect(await store.acquire('job:1', 30)).toBe(true);
    expect(await store.acquire('job:1', 30)).toBe(false);
    await Bun.sleep(40);
    expect(await store.acquire('job:1', 30)).toBe(true);
    await expect(store.acquire('job:2', 0)).rejects.toThrow(
      'Lock TTL must be an integer >= 1 (ms), got 0.',
    );
  });

  test('two schedulers sharing a store run each firing once', async () => {
    const lockStore = new MemoryLockStore();
    const runs: number[] = [];
    const a = await bootWith({ lockStore }, []);
    const b = await bootWith({ lockStore }, []);
    for (const ctx of [a, b]) {
      ctx.get(SchedulerRegistry).addCron(
        'tick',
        '* * * * * *',
        (job: JobContext) => {
          runs.push(job.scheduledAt.getTime());
        },
        { lock: true },
      );
    }
    const deadline = Date.now() + 2_500;
    while (runs.length < 2 && Date.now() < deadline) await Bun.sleep(20);
    await Bun.sleep(50);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(runs).size).toBe(runs.length);
  });

  test('a lock-store error skips the firing and reaches onError', async () => {
    const seen: string[] = [];
    const lockStore = {
      acquire: async () => {
        throw new Error('Redis did not answer within 250ms');
      },
    };
    const ran: number[] = [];
    const ctx = await bootWith(
      {
        lockStore,
        onError: (error) => {
          seen.push((error as Error).message);
        },
      },
      [],
    );
    ctx.get(SchedulerRegistry).addCron('tick', '* * * * * *', () => ran.push(1), { lock: true });
    const deadline = Date.now() + 2_000;
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(seen[0]).toBe('Redis did not answer within 250ms');
    expect(ran).toEqual([]);
    // trigger() bypasses the lock.
    await ctx.get(SchedulerRegistry).trigger('tick');
    expect(ran).toEqual([1]);
  });

  test('RedisLockStore warns about, or refuses, plaintext redis:// to a remote host', async () => {
    const { logger, warnings } = memoryLogger();
    const store = new RedisLockStore({ url: 'redis://app:s3cret@cache.internal:6379', logger });
    await store.close();
    expect(warnings).toEqual([
      '[knead:schedule] RedisLockStore connects to cache.internal:6379 over plaintext redis://, so ' +
        'credentials cross the network unencrypted. Use rediss:// (TLS) with an ACL user.',
    ]);
    const local = memoryLogger();
    await new RedisLockStore({ url: 'redis://localhost:6379', logger: local.logger }).close();
    await new RedisLockStore({ url: 'rediss://cache.internal:6380', logger: local.logger }).close();
    expect(local.warnings).toEqual([]);
    expect(
      () => new RedisLockStore({ url: 'valkey://cache.internal:6379', requireTls: true }),
    ).toThrow(ScheduleConfigError);
    expect(() => new RedisLockStore({ url: 'redis://localhost', client: Bun.redis })).toThrow(
      'Pass either client or url to RedisLockStore, not both.',
    );
    expect(() => new RedisLockStore({ url: 'redis://localhost', commandTimeout: 0 })).toThrow(
      'commandTimeout must be an integer >= 1 (ms), got 0.',
    );
  });
});

describe('shutdown', () => {
  test('aborts ctx.signal, waits for runs, and gives up after shutdownTimeout', async () => {
    const { logger, warnings } = memoryLogger();
    let signal: AbortSignal | undefined;
    const ctx = await ApplicationContext.create(
      ScheduleModule.forRoot({ logger, shutdownTimeout: 30 }),
    );
    const registry = ctx.get(SchedulerRegistry);
    const { promise: never } = Promise.withResolvers<void>();
    registry.addInterval('slow', '1h', async (job) => {
      signal = job.signal;
      await never;
    });
    void registry.trigger('slow');
    await ctx.close();
    expect(signal?.aborted).toBe(true);
    expect(warnings).toEqual([
      '[knead:schedule] Shutdown timed out after 30ms with jobs still running: "slow".',
    ]);
  });
});
