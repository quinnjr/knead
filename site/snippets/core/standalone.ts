import { ApplicationContext, inject, Module } from '@knead-js/core';
import { Database, EVENTS, JobRunner } from './lifecycle.js';

// #region module
export class ReportService {
  readonly #db = inject(Database);

  run(): string[] {
    return this.#db.connected ? ['report: 3 overdue invoices'] : [];
  }
}

@Module({
  providers: [{ provide: EVENTS, useValue: [] }, Database, JobRunner, ReportService],
})
export class ReportModule {}
// #endregion module

// #region run
export async function runReport(): Promise<string[]> {
  const context = await ApplicationContext.create(ReportModule);
  try {
    return context.get(ReportService).run();
  } finally {
    await context.close();
  }
}
// #endregion run
