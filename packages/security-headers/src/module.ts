import { type DynamicModule, inject, Module } from '@hpmws/core';
import { APP_MIDDLEWARE } from '@hpmws/http';
import { SECURITY_HEADERS_OPTIONS, SecurityHeadersMiddleware } from './middleware.js';
import type { SecurityHeadersOptions } from './options.js';

@Module({})
export class SecurityHeadersModule {
  static forRoot(options: SecurityHeadersOptions = {}): DynamicModule {
    return {
      module: SecurityHeadersModule,
      global: true,
      providers: [
        { provide: SECURITY_HEADERS_OPTIONS, useValue: options },
        SecurityHeadersMiddleware,
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useFactory: () => ({ middleware: inject(SecurityHeadersMiddleware), priority: 800 }),
        },
      ],
    };
  }
}
