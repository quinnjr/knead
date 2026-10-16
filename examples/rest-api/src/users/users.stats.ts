import { inject } from '@knead-js/core';
import { Cron } from '@knead-js/schedule';
import { UsersService } from './users.service.js';

/** Logs the user count at the top of every hour; ScheduleModule finds the job on this provider. */
export class UsersStats {
  readonly users = inject(UsersService);
  lastCount: number | undefined;

  @Cron('0 * * * *', { name: 'users.hourly-stats' })
  report() {
    this.lastCount = this.users.list().length;
    console.log(`[users] ${this.lastCount} users`);
  }
}
