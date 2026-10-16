import { describe, expect, test } from 'bun:test';
import { getMetadata } from '@knead-js/core';
import { JOBS } from '../src/decorators.js';
import { Cron, Interval, type JobContext, ScheduleConfigError, Timeout } from '../src/index.js';

describe('decorators', () => {
  test('record a job per decorated method, with options', () => {
    class Jobs {
      @Cron('0 * * * *', { name: 'hourly', timezone: 'Europe/Paris', lock: { ttl: '5m' } })
      hourly() {}
      @Interval('30s') tick() {}
      @Timeout(500, { name: 'once' }) once() {}
    }
    const specs = getMetadata(Jobs, JOBS)!;
    expect(specs.map((s) => [s.name, s.method, s.schedule.kind, s.lock])).toEqual([
      ['hourly', 'hourly', 'cron', { ttl: 300_000 }],
      [undefined, 'tick', 'interval', false],
      ['once', 'once', 'timeout', false],
    ]);
  });

  test('lock: true defers the TTL to the module', () => {
    class Jobs {
      @Cron('* * * * *', { lock: true }) a() {}
    }
    expect(getMetadata(Jobs, JOBS)![0]!.lock).toEqual({ ttl: undefined });
  });

  test('the handler calls the method on the instance, including overrides and private methods', async () => {
    const seen: string[] = [];
    class Base {
      readonly label: string = 'base';
      @Interval(100) tick(ctx: JobContext) {
        seen.push(`${this.label}:${ctx.name}`);
      }
      // biome-ignore lint/correctness/noUnusedPrivateClassMembers: called through the job's handler
      @Interval(100, { name: 'secret' }) #secret() {
        seen.push(`secret:${this.label}`);
      }
    }
    class Child extends Base {
      override readonly label = 'child';
      override tick(ctx: JobContext) {
        seen.push(`override:${ctx.name}`);
      }
    }
    const ctx = {
      name: 'n',
      signal: new AbortController().signal,
      scheduledAt: new Date(),
      trigger: 'manual' as const,
    };
    const specs = getMetadata(Child, JOBS)!;
    for (const spec of specs) await spec.handler(new Child())(ctx);
    expect(seen).toEqual(['override:n', 'secret:child']);
  });

  test('subclass jobs do not leak into the parent', () => {
    class Parent {
      @Interval(100) a() {}
    }
    class Sub extends Parent {
      @Interval(100) b() {}
    }
    expect(getMetadata(Parent, JOBS)!.map((s) => s.method)).toEqual(['a']);
    expect(getMetadata(Sub, JOBS)!.map((s) => s.method)).toEqual(['a', 'b']);
  });

  test('invalid schedules fail when the decorator is evaluated', () => {
    expect(() => Cron('not a pattern')).toThrow(ScheduleConfigError);
    expect(() => Cron('61 * * * *')).toThrow(ScheduleConfigError);
    expect(() => Cron('* * * * *', { timezone: 'Not/AZone' })).toThrow(/Not\/AZone/);
    expect(() => Cron('* * * * *', { name: '' })).toThrow(ScheduleConfigError);
    expect(() => Cron('* * * * *', { lock: { ttl: '0s' } })).toThrow(ScheduleConfigError);
    expect(() => Cron('* * * * *', { lock: 'yes' as never })).toThrow(ScheduleConfigError);
    expect(() => Interval(0)).toThrow(ScheduleConfigError);
    expect(() => Interval('1w' as never)).toThrow(ScheduleConfigError);
    expect(() => Timeout(-5)).toThrow(ScheduleConfigError);
  });

  test('static methods are refused', () => {
    expect(() => {
      class Jobs {
        @Interval(100) static tick() {}
      }
      void Jobs;
    }).toThrow(/instance methods/);
  });
});
