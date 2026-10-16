import type { ModuleInjector, Type } from '@knead/core';
import { HttpConfigError } from './exceptions.js';
import type {
  Ctx,
  ExceptionFilter,
  FilterRef,
  Guard,
  GuardFn,
  GuardRef,
  Middleware,
  MiddlewareFn,
  MiddlewareRef,
} from './types.js';

function isClassWith(value: unknown, method: string): value is Type {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: Record<string, unknown> }).prototype?.[method] === 'function'
  );
}

export function resolveMiddleware(ref: MiddlewareRef, injector: ModuleInjector): Middleware {
  if (isClassWith(ref, 'use')) return injector.resolveOrConstruct(ref as Type<Middleware>);
  if (typeof ref === 'function') return { use: ref as MiddlewareFn };
  return ref;
}

function isClass(value: Function): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function describe(ref: unknown): string {
  if (ref === undefined) return 'undefined (often a circular import)';
  if (typeof ref === 'function') return `class ${ref.name || '(anonymous)'}`;
  if (ref === null) return 'null';
  return typeof ref === 'object' ? 'an object without a canActivate() method' : String(ref);
}

/**
 * Checks that `ref` is a guard: an object with a `canActivate` function, a guard function, or a
 * class with `canActivate` on its prototype. Anything else (including `undefined` from a
 * circular import, or a class whose `canActivate` is an instance arrow field) is an
 * HttpConfigError naming `where`.
 */
export function assertGuardRef(ref: unknown, where: string): asserts ref is GuardRef<any> {
  if (typeof ref === 'function') {
    if (isClassWith(ref, 'canActivate') || !isClass(ref)) return;
  } else if (
    typeof ref === 'object' &&
    ref !== null &&
    typeof (ref as { canActivate?: unknown }).canActivate === 'function'
  ) {
    return;
  }
  throw new HttpConfigError(
    `Invalid guard in ${where}: ${describe(ref)}. A guard is an object with canActivate(), a ` +
      'function, or a class with a canActivate() method (not an arrow-function field).',
  );
}

export function resolveGuard(
  ref: GuardRef<any>,
  injector: ModuleInjector,
  where = 'a guard list',
): Guard<any> {
  assertGuardRef(ref, where);
  if (isClassWith(ref, 'canActivate')) return injector.resolveOrConstruct(ref as Type<Guard<any>>);
  if (typeof ref === 'function') return { canActivate: ref as GuardFn<Ctx> };
  return ref;
}

export function resolveFilter(ref: FilterRef, injector: ModuleInjector): ExceptionFilter {
  if (isClassWith(ref, 'catch')) return injector.resolveOrConstruct(ref as Type<ExceptionFilter>);
  return ref as ExceptionFilter;
}
