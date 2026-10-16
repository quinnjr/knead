import { Cron, Interval, type JobContext, type SchedulerRegistry, Timeout } from '../src/index.js';

// Never instantiated: only type-checked.
export class TypeAssertions {
  @Cron('* * * * *') noArgs() {}
  @Interval(100) withContext(ctx: JobContext) {
    void ctx.signal;
  }
  @Timeout('5s') async asyncJob(_ctx: JobContext): Promise<number> {
    return 1;
  }
  // @ts-expect-error a job receives a JobContext, not a number
  @Interval(100) wrongParam(_n: number) {}
  // @ts-expect-error a second required parameter is never passed
  @Interval(100) tooMany(_ctx: JobContext, _extra: string) {}
  // @ts-expect-error fields cannot be jobs
  @Interval(100) field = () => {};
  // @ts-expect-error durations are numbers or unit strings
  @Interval('5 seconds') badDuration() {}
}

export function registryTypes(registry: SchedulerRegistry): void {
  registry.addCron('c', '* * * * *', (ctx) => void ctx.scheduledAt, {
    timezone: 'UTC',
    lock: true,
  });
  // @ts-expect-error names come from the first argument, not options
  registry.addCron('c', '* * * * *', () => {}, { name: 'x' });
  registry.addInterval('i', '1m', async () => {});
  // @ts-expect-error intervals cannot be locked
  registry.addInterval('i', '1m', () => {}, { lock: true });
}
