// Pins what the @knead-js/schedule README's quick start says about its jobs.
import { afterEach, expect, test } from 'bun:test';
import { ApplicationContext } from '@knead-js/core';
import { SchedulerRegistry } from '@knead-js/schedule';
import { AppModule, ReportService } from '../snippets/readme/schedule.js';

let ctx: ApplicationContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

test('the quick start registers its three jobs under the names it gives', async () => {
  ctx = await ApplicationContext.create(AppModule);
  const jobs = ctx.get(SchedulerRegistry).list();
  expect(jobs.map(({ name, kind, state }) => ({ name, kind, state }))).toEqual([
    { name: 'nightly-report', kind: 'cron', state: 'scheduled' },
    { name: 'ReportJobs.heartbeat', kind: 'interval', state: 'scheduled' },
    { name: 'warm-cache', kind: 'timeout', state: 'scheduled' },
  ]);
  const heartbeat = jobs.find((j) => j.name === 'ReportJobs.heartbeat')!;
  const delay = heartbeat.nextRunAt!.getTime() - Date.now();
  expect(delay).toBeGreaterThan(29_000);
  expect(delay).toBeLessThanOrEqual(30_000);
});

test('the nightly report builds the report for the scheduled time', async () => {
  ctx = await ApplicationContext.create(AppModule);
  await ctx.get(SchedulerRegistry).trigger('nightly-report');
  expect(ctx.get(ReportService).built).toHaveLength(1);
});
