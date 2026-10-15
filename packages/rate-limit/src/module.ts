import { type DynamicModule, inject, Module } from '@hpmws/core';
import { APP_MIDDLEWARE } from '@hpmws/http';
import { parseDuration } from './duration.js';
import { MemoryStore } from './memory-store.js';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  RateLimitMiddleware,
  type RateLimitModuleOptions,
} from './middleware.js';

@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions): DynamicModule {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError(`Rate limit must be a positive integer, got ${options.limit}`);
    }
    parseDuration(options.window);
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
