import { type DynamicModule, KneadError, Module } from '@knead-js/core';
import { APP_FILTER } from '@knead-js/http';
import { PrismaExceptionFilter } from './filter.js';
import { PRISMA_HTTP_OPTIONS, type PrismaHttpOptions } from './tokens.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throws a KneadError unless `options.map` is undefined or a plain object of functions. */
function assertHttpOptions(options: unknown): asserts options is PrismaHttpOptions {
  if (typeof options !== 'object' || options === null) {
    throw new KneadError('PrismaHttpModule options must be an object.');
  }
  const { map } = options as { map?: unknown };
  if (map === undefined) return;
  if (!isPlainObject(map)) {
    throw new KneadError('PrismaHttpModule `map` must be a plain object of mapper functions.');
  }
  for (const [key, mapper] of Object.entries(map)) {
    if (typeof mapper !== 'function') {
      throw new KneadError(`PrismaHttpModule \`map.${key}\` must be a function.`);
    }
  }
}

@Module({})
export class PrismaHttpModule {
  static forRoot(options: PrismaHttpOptions = {}): DynamicModule {
    assertHttpOptions(options);
    return {
      module: PrismaHttpModule,
      providers: [
        { provide: PRISMA_HTTP_OPTIONS, useValue: options },
        { provide: APP_FILTER, multi: true, useClass: PrismaExceptionFilter },
      ],
    };
  }
}
