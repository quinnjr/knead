import { Injectable, inject, Module } from '@knead-js/core';
import { Cron, Interval, type JobContext, ScheduleModule, Timeout } from '@knead-js/schedule';

// #region service
@Injectable()
export class ReportService {
  readonly built: Date[] = [];

  async build(day: Date, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.built.push(day);
  }

  async warmCache(): Promise<void> {}

  ping(): void {}
}
// #endregion service

// #region jobs
@Injectable()
export class ReportJobs {
  readonly reports = inject(ReportService);

  @Cron('0 3 * * *', { name: 'nightly-report', timezone: 'America/New_York' })
  async nightly({ scheduledAt, signal }: JobContext) {
    await this.reports.build(scheduledAt, signal);
  }

  // Named 'ReportJobs.heartbeat' by default.
  @Interval('30s')
  heartbeat() {
    this.reports.ping();
  }

  @Timeout('5s', { name: 'warm-cache' })
  async warmCache() {
    await this.reports.warmCache();
  }
}
// #endregion jobs

// #region module
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ReportService, ReportJobs],
})
export class AppModule {}
// #endregion module
