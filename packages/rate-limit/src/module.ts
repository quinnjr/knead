import { type DynamicModule, inject, Module } from '@knead/core';
import { APP_MIDDLEWARE } from '@knead/http';
import { MemoryStore } from './memory-store.js';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  RateLimiter,
  RateLimitGuard,
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
        RateLimiter,
        RateLimitMiddleware,
        RateLimitGuard,
        ...(options.middleware === false
          ? []
          : [
              {
                provide: APP_MIDDLEWARE,
                multi: true as const,
                useFactory: () => ({ middleware: inject(RateLimitMiddleware), priority: 900 }),
              },
            ]),
      ],
      exports: [RATE_LIMIT_STORE, RATE_LIMIT_OPTIONS, RateLimiter, RateLimitGuard],
    };
  }
}
