import { type DynamicModule, KneadError, Module } from '@knead-js/core';
import { APP_FILTER } from '@knead-js/http';
import { PrismaExceptionFilter } from './filter.js';
import { PRISMA_HTTP_OPTIONS, type PrismaHttpOptions } from './tokens.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates `options` and returns a snapshot of them. `map` is copied first (each own key read
 * exactly once, so a getter cannot change its answer) and the copy is what gets validated, frozen
 * and stored.
 */
function snapshotHttpOptions(options: unknown): PrismaHttpOptions {
  if (typeof options !== 'object' || options === null) {
    throw new KneadError('PrismaHttpModule options must be an object.');
  }
  const { map } = options as { map?: unknown };
  if (map === undefined) return options as PrismaHttpOptions;
  if (!isPlainObject(map)) {
    throw new KneadError('PrismaHttpModule `map` must be a plain object of mapper functions.');
  }
  const copy: Record<PropertyKey, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(map)) copy[key] = map[key as string];
  for (const key of Reflect.ownKeys(copy)) {
    if (typeof copy[key] !== 'function') {
      throw new KneadError(`PrismaHttpModule \`map.${String(key)}\` must be a function.`);
    }
  }
  return { ...(options as PrismaHttpOptions), map: Object.freeze(copy) as never };
}

@Module({})
export class PrismaHttpModule {
  static forRoot(options: PrismaHttpOptions = {}): DynamicModule {
    const stored = snapshotHttpOptions(options);
    return {
      module: PrismaHttpModule,
      providers: [
        { provide: PRISMA_HTTP_OPTIONS, useValue: stored },
        { provide: APP_FILTER, multi: true, useClass: PrismaExceptionFilter },
      ],
    };
  }
}
