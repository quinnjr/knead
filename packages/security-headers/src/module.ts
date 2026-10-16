import { type DynamicModule, inject, Module } from '@knead/core';
import { APP_MIDDLEWARE } from '@knead/http';
import { SECURITY_HEADERS_OPTIONS, SecurityHeadersMiddleware } from './middleware.js';
import { type SecurityHeadersOptions, validateSecurityHeadersOptions } from './options.js';

@Module({})
export class SecurityHeadersModule {
  static forRoot(options: SecurityHeadersOptions = {}): DynamicModule {
    validateSecurityHeadersOptions(options);
    return {
      module: SecurityHeadersModule,
      global: true,
      providers: [
        { provide: SECURITY_HEADERS_OPTIONS, useValue: options },
        SecurityHeadersMiddleware,
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useFactory: () => ({ middleware: inject(SecurityHeadersMiddleware), priority: 1100 }),
        },
      ],
    };
  }
}
