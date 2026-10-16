import { type DynamicModule, inject, Module } from '@knead/core';
import { APP_MIDDLEWARE } from '@knead/http';
import { CorsMiddleware } from './middleware.js';
import { CORS_OPTIONS, type CorsOptions, validateCorsOptions } from './options.js';

@Module({})
export class CorsModule {
  static forRoot(options: CorsOptions): DynamicModule {
    validateCorsOptions(options);
    return {
      module: CorsModule,
      global: true,
      providers: [
        { provide: CORS_OPTIONS, useValue: options },
        CorsMiddleware,
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useFactory: () => ({ middleware: inject(CorsMiddleware), priority: 1000 }),
        },
      ],
    };
  }
}
