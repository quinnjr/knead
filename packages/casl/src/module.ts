import { type DynamicModule, Module } from '@knead-js/core';
import { APP_FILTER } from '@knead-js/http';
import { CaslForbiddenFilter } from './filter.js';
import { AbilityGuard } from './guard.js';
import { CASL_OPTIONS, type CaslModuleOptions, validateCaslOptions } from './options.js';
import { AbilityService } from './service.js';

/**
 * Global. Does not register AbilityGuard globally; opt in with
 * `{ provide: APP_GUARD, multi: true, useExisting: AbilityGuard }` or use `@UseGuards(AbilityGuard)`.
 */
@Module({})
export class CaslModule {
  static forRoot<U>(options: CaslModuleOptions<U>): DynamicModule {
    validateCaslOptions(options);
    return {
      module: CaslModule,
      global: true,
      providers: [
        { provide: CASL_OPTIONS, useValue: options },
        AbilityService,
        AbilityGuard,
        { provide: APP_FILTER, multi: true, useClass: CaslForbiddenFilter },
      ],
      exports: [CASL_OPTIONS, AbilityService, AbilityGuard],
    };
  }
}
