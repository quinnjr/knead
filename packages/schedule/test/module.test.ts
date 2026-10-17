import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  ApplicationContext,
  inject,
  MemoryLogger,
  Module,
  type ModuleImport,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@knead-js/core';
import { Test } from '@knead-js/testing';
import { SCHEDULE_CLOCK } from '../src/clock.js';
import {
  Cron,
  Interval,
  type JobContext,
  MemoryLockStore,
  ScheduleConfigError,
  ScheduleModule,
  type ScheduleModuleOptions,
  SchedulerRegistry,
  Timeout,
} from '../src/index.js';
import { deferred, ManualClock } from './manual-clock.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let ctx: ApplicationContext | undefined;
let clock: ManualClock;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function boot(
  imports: ModuleImport[],
  providers: Function[] = [],
  options: ScheduleModuleOptions = {},
) {
  clock = new ManualClock(T0);
  @Module({ imports: [ScheduleModule.forRoot(options), ...imports], providers: providers as never })
  class AppModule {}
  ctx = await ApplicationContext.create(AppModule, {
    overrides: [[SCHEDULE_CLOCK, { provide: SCHEDULE_CLOCK, useValue: clock }]],
  });
  return { ctx, registry: ctx.get(SchedulerRegistry) };
}

class Counter {
  readonly calls: string[] = [];
}

describe('ScheduleModule', () => {
  test('discovers decorated jobs in every module and runs them with injected dependencies', async () => {
    class ReportJobs {
      readonly counter = inject(Counter);
      @Cron('0 * * * *', { timezone: 'UTC' }) hourly(job: JobContext) {
        this.counter.calls.push(`hourly@${job.scheduledAt.toISOString()}`);
      }
      @Interval('10m', { name: 'tick' }) tick() {
        this.counter.calls.push('tick');
      }
    }
    class FeatureJobs {
      readonly counter = inject(Counter);
      @Timeout('1s') warmup() {
        this.counter.calls.push('warmup');
      }
    }
    @Module({ providers: [FeatureJobs, Counter], exports: [Counter] })
    class FeatureModule {}
    const { registry } = await boot([FeatureModule], [ReportJobs]);
    expect(
      registry
        .list()
        .map((j) => j.name)
        .sort(),
    ).toEqual(['FeatureJobs.warmup', 'ReportJobs.hourly', 'tick']);
    await clock.advance(3_600_000);
    expect(ctx!.get(Counter).calls).toEqual([
      'warmup',
      'tick',
      'tick',
      'tick',
      'tick',
      'tick',
      'hourly@2026-01-01T01:00:00.000Z',
      'tick',
    ]);
  });

  test('a class provided by two modules registers its jobs once', async () => {
    class Shared {
      @Interval(100) tick() {}
    }
    @Module({ providers: [Shared] })
    class A {}
    @Module({ providers: [Shared] })
    class B {}
    const { registry } = await boot([A, B]);
    expect(registry.list().map((j) => j.name)).toEqual(['Shared.tick']);
  });

  test('duplicate names fail at bootstrap', async () => {
    class One {
      @Interval(100, { name: 'same' }) a() {}
    }
    class Two {
      @Interval(100, { name: 'same' }) b() {}
    }
    await expect(boot([], [One, Two])).rejects.toThrow(/"same" already exists/);
    ctx = undefined;
  });

  test('a locked job without a lockStore fails at bootstrap', async () => {
    class Locked {
      @Cron('* * * * *', { lock: true }) a() {}
    }
    await expect(boot([], [Locked])).rejects.toThrow(ScheduleConfigError);
    ctx = undefined;
  });

  test('a locked job with a lockStore runs', async () => {
    const calls: string[] = [];
    class Locked {
      @Cron('* * * * *', { lock: true }) a() {
        calls.push('a');
      }
    }
    await boot([], [Locked], { lockStore: new MemoryLockStore() });
    await clock.advance(60_000);
    expect(calls).toEqual(['a']);
  });

  test('enabled: false registers jobs paused', async () => {
    const calls: string[] = [];
    class Jobs {
      @Interval(100) a() {
        calls.push('a');
      }
    }
    const { registry } = await boot([], [Jobs], { enabled: false });
    await clock.advance(1_000);
    expect(calls).toEqual([]);
    expect(registry.get('Jobs.a')!.state).toBe('paused');
    await registry.trigger('Jobs.a');
    expect(calls).toEqual(['a']);
  });

  test('jobs added at runtime run, and can be paused, resumed and removed', async () => {
    const { registry } = await boot([]);
    const calls: string[] = [];
    registry.addInterval('i', '1s', () => {
      calls.push('i');
    });
    registry.addCron('c', '*/2 * * * * *', () => {
      calls.push('c');
    });
    registry.addTimeout('t', 1_500, () => {
      calls.push('t');
    });
    await clock.advance(2_000);
    expect(calls.slice(0, 2)).toEqual(['i', 't']);
    expect(calls.slice(2).sort()).toEqual(['c', 'i']);
    registry.pause('i');
    await clock.advance(2_000);
    expect(calls.filter((c) => c === 'i')).toHaveLength(2);
    registry.resume('i');
    expect(registry.remove('c')).toBe(true);
    await clock.advance(1_000);
    expect(calls.slice(4)).toEqual(['c', 'i']);
    expect(() => registry.addInterval('', 1, () => {})).toThrow(ScheduleConfigError);
    expect(() => registry.addInterval('x', 1, 'nope' as never)).toThrow(ScheduleConfigError);
    expect(() => registry.addCron('y', 'bad', () => {})).toThrow(ScheduleConfigError);
  });

  test('jobs registered before bootstrap are armed at bootstrap', async () => {
    const calls: string[] = [];
    class Early implements OnModuleInit {
      readonly registry = inject(SchedulerRegistry);
      onModuleInit() {
        this.registry.addInterval('early', 100, () => {
          calls.push('early');
        });
      }
    }
    const { registry } = await boot([], [Early]);
    expect(registry.get('early')!.nextRunAt).toEqual(new Date(T0 + 100));
    await clock.advance(100);
    expect(calls).toEqual(['early']);
  });

  test('shutdown waits for runs in progress before providers are destroyed', async () => {
    const order: string[] = [];
    const gate = deferred();
    let signal: AbortSignal | undefined;
    class Db implements OnModuleDestroy {
      onModuleDestroy() {
        order.push('db destroyed');
      }
    }
    class Jobs {
      readonly db = inject(Db);
      @Interval(100) async slow(job: JobContext) {
        signal = job.signal;
        await gate.promise;
        order.push('job finished');
      }
    }
    await boot([], [Db, Jobs]);
    await clock.advance(100);
    const closing = ctx!.close();
    ctx = undefined;
    await clock.advance(0);
    expect(signal!.aborted).toBe(true);
    expect(order).toEqual([]);
    gate.resolve();
    await closing;
    expect(order).toEqual(['job finished', 'db destroyed']);
  });

  test('invalid options fail at forRoot', () => {
    expect(() => ScheduleModule.forRoot({ lockTtl: '0s' })).toThrow(ScheduleConfigError);
    expect(() => ScheduleModule.forRoot({ shutdownTimeout: 'soon' as never })).toThrow(
      ScheduleConfigError,
    );
    expect(() => ScheduleModule.forRoot({ lockStore: {} as never })).toThrow(/acquire/);
    expect(() => ScheduleModule.forRoot({ onError: 'x' as never })).toThrow(ScheduleConfigError);
    expect(() => ScheduleModule.forRoot({ enabled: 'no' as never })).toThrow(ScheduleConfigError);
  });

  test('works in an HTTP application built with @knead-js/testing', async () => {
    const ran = deferred<string>();
    class Jobs {
      @Timeout(5) once(job: JobContext) {
        ran.resolve(job.name);
      }
    }
    const mod = await Test.createModule({
      imports: [ScheduleModule.forRoot()],
      providers: [Jobs],
    }).compile();
    try {
      expect(await ran.promise).toBe('Jobs.once');
      await Bun.sleep(0);
      expect(mod.get(SchedulerRegistry).list()).toEqual([]);
    } finally {
      await mod.close();
    }
  });

  test('jobs on transient providers are refused', async () => {
    class Transient {
      @Interval(100) a() {}
    }
    @Module({ providers: [{ provide: Transient, useClass: Transient, scope: 'transient' }] })
    class Feature {}
    await expect(boot([Feature])).rejects.toThrow(/transient/);
    ctx = undefined;
  });

  test('anonymous classes get a readable default name', async () => {
    const Anon = (() =>
      class {
        @Interval(100) tick() {}
      })();
    Object.defineProperty(Anon, 'name', { value: '' });
    const { registry } = await boot([], [Anon]);
    expect(registry.list().map((j) => j.name)).toEqual(['<anonymous>.tick']);
  });

  test('importing ScheduleModule.forRoot() twice fails at bootstrap', async () => {
    class Jobs {
      @Interval(100) a() {}
    }
    @Module({ imports: [ScheduleModule.forRoot()] })
    class Other {}
    await expect(boot([Other], [Jobs])).rejects.toThrow(/more than once/);
    ctx = undefined;
  });

  test('a configured logger receives the default failure report', async () => {
    const errors: unknown[][] = [];
    class Jobs {
      @Interval(100) bad() {
        throw new Error('boom');
      }
    }
    await boot([], [Jobs], { logger: { warn: () => {}, error: (...args) => errors.push(args) } });
    await clock.advance(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(['[knead:schedule] Job "Jobs.bad" failed: Error: boom']);
    expect(() => ScheduleModule.forRoot({ logger: {} as never })).toThrow(/logger/);
  });

  test("without a logger option, reports go to the application's LOGGER", async () => {
    class Jobs {
      @Interval(100) bad() {
        throw new Error('boom');
      }
    }
    clock = new ManualClock(T0);
    const logger = new MemoryLogger();
    @Module({ imports: [ScheduleModule.forRoot()], providers: [Jobs] })
    class AppModule {}
    ctx = await ApplicationContext.create(AppModule, {
      logger,
      overrides: [[SCHEDULE_CLOCK, { provide: SCHEDULE_CLOCK, useValue: clock }]],
    });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await clock.advance(100);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(logger.entries).toEqual([
      { level: 'error', message: '[knead:schedule] Job "Jobs.bad" failed: Error: boom', meta: [] },
    ]);
  });

  test("a lock store built outside DI receives the application's LOGGER", async () => {
    const logger = new MemoryLogger();
    const received: unknown[] = [];
    const lockStore = {
      acquire: async () => true,
      setLogger: (l: unknown) => received.push(l),
    };
    @Module({ imports: [ScheduleModule.forRoot({ lockStore })] })
    class AppModule {}
    ctx = await ApplicationContext.create(AppModule, { logger });
    expect(received).toEqual([logger]);
  });

  test('the default failure report is a redacted summary, never the raw error', async () => {
    const errors: unknown[][] = [];
    class Jobs {
      @Interval(100) leak() {
        const error = new Error('connect redis://app:hunter2@cache:6379 refused');
        error.stack = 'stack with request data';
        throw error;
      }
    }
    await boot([], [Jobs], {
      onError: undefined,
      logger: { warn: () => {}, error: (...args) => errors.push(args) },
    });
    await clock.advance(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    const line = String(errors[0]![0]);
    expect(line).toContain('Error: connect redis://');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('stack with request data');
  });
});
