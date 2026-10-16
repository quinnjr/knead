import { type DynamicModule, Module } from '@knead-js/core';
import { APP_FILTER } from '@knead-js/http';
import { PrismaExceptionFilter } from './filter.js';
import { PRISMA_HTTP_OPTIONS, type PrismaHttpOptions } from './tokens.js';

@Module({})
export class PrismaHttpModule {
  static forRoot(options: PrismaHttpOptions = {}): DynamicModule {
    return {
      module: PrismaHttpModule,
      providers: [
        { provide: PRISMA_HTTP_OPTIONS, useValue: options },
        { provide: APP_FILTER, multi: true, useClass: PrismaExceptionFilter },
      ],
    };
  }
}
