import { inject } from '@knead-js/core';
import { type JobInfo, SchedulerRegistry } from '@knead-js/schedule';
import { ReportService } from './report-jobs.js';

export interface Tenant {
  id: string;
  reportCron: string;
  timezone: string;
}

// #region registry
export class TenantReports {
  readonly #registry = inject(SchedulerRegistry);
  readonly #reports = inject(ReportService);

  schedule(tenant: Tenant): void {
    this.#registry.addCron(
      `tenant-report:${tenant.id}`,
      tenant.reportCron,
      ({ scheduledAt, signal }) => this.#reports.build(scheduledAt, signal),
      { timezone: tenant.timezone },
    );
  }

  unschedule(tenantId: string): boolean {
    return this.#registry.remove(`tenant-report:${tenantId}`);
  }

  runNow(tenantId: string): Promise<void> {
    return this.#registry.trigger(`tenant-report:${tenantId}`);
  }

  status(): JobInfo[] {
    return this.#registry.list().filter((job) => job.name.startsWith('tenant-report:'));
  }
}
// #endregion registry
