import { getMetadata, type ModuleRef } from '@knead-js/core';
import { JOBS } from './decorators.js';
import { ScheduleConfigError } from './errors.js';
import type { JobDefinition } from './scheduler.js';

/**
 * Jobs declared with @Cron/@Interval/@Timeout on class providers of every module. A class provided
 * by several modules contributes its jobs once, from the first module's instance. Jobs on
 * transient and multi providers are refused.
 */
export function discoverJobs(modules: readonly ModuleRef[]): JobDefinition[] {
  const seen = new Set<Function>();
  const jobs: JobDefinition[] = [];
  for (const mod of modules) {
    for (const record of mod.injector.ownRecords()) {
      const provider = record.provider;
      if (provider.kind !== 'class') continue;
      const className = provider.useClass.name || '<anonymous>';
      // A multi token resolves to an array of every entry, not to this class's instance.
      if (provider.multi) {
        if (!getMetadata(provider.useClass, JOBS)?.length) continue;
        throw new ScheduleConfigError(
          `${className} has scheduled jobs but is a multi provider; jobs need a singleton ` +
            'provider of their own (list the class in providers, and use useExisting in the ' +
            'multi entry).',
        );
      }
      if (seen.has(provider.useClass)) continue;
      const specs = getMetadata(provider.useClass, JOBS);
      if (!specs?.length) continue;
      seen.add(provider.useClass);
      if (provider.scope !== 'singleton') {
        throw new ScheduleConfigError(
          `${className} has scheduled jobs but is a ${provider.scope} provider; jobs need a ` +
            'singleton instance that receives lifecycle hooks.',
        );
      }
      const instance = mod.injector.get(provider.token) as object;
      for (const spec of specs) {
        jobs.push({
          name: spec.name ?? `${className}.${String(spec.method)}`,
          schedule: spec.schedule,
          handler: spec.handler(instance),
          lock: spec.lock,
        });
      }
    }
  }
  return jobs;
}
