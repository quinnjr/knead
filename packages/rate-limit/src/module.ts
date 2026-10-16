import { type DynamicModule, inject, Module } from '@hpmws/core';
import { APP_MIDDLEWARE } from '@hpmws/http';
import { MemoryStore } from './memory-store.js';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  RateLimitMiddleware,
  type RateLimitModuleOptions,
  validateRateLimitOptions,
} from './middleware.js';

@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions): DynamicModule {
    validateRateLimitOptions(options);
    return {
      module: RateLimitModule,
      global: true,
      providers: [
        { provide: RATE_LIMIT_OPTIONS, useValue: options },
        { provide: RATE_LIMIT_STORE, useFactory: () => options.store ?? new MemoryStore() },
        RateLimitMiddleware,
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useFactory: () => ({ middleware: inject(RateLimitMiddleware), priority: 900 }),
        },
      ],
      exports: [RATE_LIMIT_STORE],
    };
  }
}
