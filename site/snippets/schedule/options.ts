import { ConsoleLogger, Module, summarizeError } from '@knead-js/core';
import { type JobContext, ScheduleModule } from '@knead-js/schedule';

// #region options
const logger = new ConsoleLogger('jobs');

export const failures = new Map<string, number>();

function reportFailure(error: unknown, ctx: JobContext): void {
  failures.set(ctx.name, (failures.get(ctx.name) ?? 0) + 1);
  // summarizeError gives a redacted `Name: message`, without stack or properties.
  logger.error(`Job ${ctx.name} (${ctx.trigger}) failed: ${summarizeError(error)}`);
}

@Module({
  imports: [
    ScheduleModule.forRoot({
      // Web-only replicas register every job paused.
      enabled: process.env.RUN_JOBS !== 'false',
      shutdownTimeout: '30s',
      logger,
      onError: reportFailure,
    }),
  ],
})
export class AppModule {}
// #endregion options
