// #region test
import { afterEach, expect, test } from 'bun:test';
import { ScheduleModule, SchedulerRegistry } from '@knead-js/schedule';
import { Test, type TestingModule } from '@knead-js/testing';
import { ReportJobs, ReportService } from './report-jobs.js';

let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
});

test('the nightly report builds a report for the scheduled day', async () => {
  moduleRef = await Test.createModule({
    // Paused: nothing runs on its own while the test is going.
    imports: [ScheduleModule.forRoot({ enabled: false })],
    providers: [ReportService, ReportJobs],
  }).compile();

  await moduleRef.get(SchedulerRegistry).trigger('nightly-report');

  expect(moduleRef.get(ReportService).built).toHaveLength(1);
});
// #endregion test
