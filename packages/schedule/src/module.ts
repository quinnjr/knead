import { type DynamicModule, Module } from '@knead-js/core';
import { realClock, SCHEDULE_CLOCK } from './clock.js';
import { resolveScheduleOptions, SCHEDULE_OPTIONS, type ScheduleModuleOptions } from './options.js';
import { SchedulerRegistry } from './registry.js';

@Module({})
export class ScheduleModule {
  /** Global: jobs on providers of every module are discovered when the application bootstraps. */
  static forRoot(options: ScheduleModuleOptions = {}): DynamicModule {
    resolveScheduleOptions(options);
    return {
      module: ScheduleModule,
      global: true,
      providers: [
        { provide: SCHEDULE_OPTIONS, useValue: options },
        { provide: SCHEDULE_CLOCK, useValue: realClock },
        SchedulerRegistry,
      ],
      exports: [SchedulerRegistry, SCHEDULE_OPTIONS],
    };
  }
}
