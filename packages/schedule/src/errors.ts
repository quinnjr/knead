import { KneadError } from '@knead-js/core';

/** An invalid job, schedule or option, or a change made after the scheduler shut down. */
export class ScheduleConfigError extends KneadError {}

export class ScheduleJobNotFoundError extends KneadError {
  constructor(readonly jobName: string) {
    super(`No scheduled job named "${jobName}".`);
  }
}
