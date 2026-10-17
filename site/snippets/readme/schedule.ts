// #region quick-start
import { inject, Module } from '@knead-js/core';
import { Cron, Interval, type JobContext, ScheduleModule, Timeout } from '@knead-js/schedule';

export class ReportService {
  readonly built: string[] = [];

  async build(day: Date, signal: AbortSignal): Promise<void> {
    // Pass `signal` to fetch and database calls so shutdown can cancel them.
    signal.throwIfAborted();
    this.built.push(day.toISOString());
  }

  async warmCache(): Promise<void> {}
}

export class ReportJobs {
  readonly reports = inject(ReportService);

  // 03:00 every day, New York time.
  @Cron('0 3 * * *', { name: 'nightly-report', timezone: 'America/New_York' })
  async nightly({ scheduledAt, signal }: JobContext) {
    await this.reports.build(scheduledAt, signal);
  }

  // Every 30 seconds, starting 30 seconds after startup. Named 'ReportJobs.heartbeat'.
  @Interval('30s')
  heartbeat() {}

  // Once, 5 seconds after startup.
  @Timeout('5s', { name: 'warm-cache' })
  async warmCache() {
    await this.reports.warmCache();
  }
}

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ReportService, ReportJobs],
})
export class AppModule {}
// #endregion quick-start
