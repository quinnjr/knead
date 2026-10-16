import { inject } from '@knead-js/core';
import { LOGGER } from '@knead-js/http';
import { Cron } from '@knead-js/schedule';
import { UsersService } from './users.service.js';

/** Logs the user count at the top of every hour; ScheduleModule finds the job on this provider. */
export class UsersStats {
  readonly users = inject(UsersService);
  readonly logger = inject(LOGGER);
  lastCount: number | undefined;

  @Cron('0 * * * *', { name: 'users.hourly-stats' })
  report() {
    this.lastCount = this.users.list().length;
    this.logger.info(`${this.lastCount} users`);
  }
}
