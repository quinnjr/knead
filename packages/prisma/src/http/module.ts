import {
  type DynamicModule,
  InjectionToken,
  inject,
  KneadError,
  MODULES,
  Module,
} from '@knead-js/core';
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

const PRISMA_HTTP_SETUP = new InjectionToken<true>('knead:prisma-http:setup');

/**
 * Fails startup when PrismaHttpModule is imported without forRoot() (no filter would be
 * registered) or forRoot() is imported more than once (the first filter would answer every
 * Prisma error, silently ignoring the other imports' `map`).
 */
function checkSetup(): true {
  if (inject(PRISMA_HTTP_OPTIONS, { optional: true }) === undefined) {
    throw new KneadError('Import PrismaHttpModule.forRoot(), not PrismaHttpModule');
  }
  const count = inject(MODULES).filter((m) => m.metatype === PrismaHttpModule).length;
  if (count > 1) {
    throw new KneadError(
      `PrismaHttpModule.forRoot() is imported ${count} times; import it once, in the root module`,
    );
  }
  return true;
}

@Module({ providers: [{ provide: PRISMA_HTTP_SETUP, useFactory: checkSetup }] })
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
