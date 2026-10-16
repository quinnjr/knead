import { getMetadata, type ModuleRef } from '@knead-js/core';
import { JOBS } from './decorators.js';
import type { JobDefinition } from './scheduler.js';

/**
 * Jobs declared with @Cron/@Interval/@Timeout on class providers of every module. A class provided
 * by several modules contributes its jobs once, from the first module's instance.
 */
export function discoverJobs(modules: readonly ModuleRef[]): JobDefinition[] {
  const seen = new Set<Function>();
  const jobs: JobDefinition[] = [];
  for (const mod of modules) {
    for (const record of mod.injector.ownRecords()) {
      const provider = record.provider;
      if (provider.kind !== 'class' || provider.multi || seen.has(provider.useClass)) continue;
      const specs = getMetadata(provider.useClass, JOBS);
      if (!specs?.length) continue;
      seen.add(provider.useClass);
      const instance = mod.injector.get(provider.token) as object;
      for (const spec of specs) {
        jobs.push({
          name: spec.name ?? `${provider.useClass.name}.${String(spec.method)}`,
          schedule: spec.schedule,
          handler: spec.handler(instance),
          lock: spec.lock,
        });
      }
    }
  }
  return jobs;
}
