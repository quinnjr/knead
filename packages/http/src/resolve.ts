import type { ModuleInjector, Type } from '@knead-js/core';
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

function isClass(value: Function): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function describe(ref: unknown, method: string): string {
  if (ref === undefined) return 'undefined (often a circular import)';
  if (typeof ref === 'function') {
    return `${isClass(ref) ? 'class' : 'function'} ${ref.name || '(anonymous)'}`;
  }
  if (ref === null) return 'null';
  return typeof ref === 'object' ? `an object without a ${method}() method` : String(ref);
}

function hasMethod(ref: unknown, method: string): boolean {
  return (
    typeof ref === 'object' &&
    ref !== null &&
    typeof (ref as Record<string, unknown>)[method] === 'function'
  );
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
  } else if (hasMethod(ref, 'canActivate')) {
    return;
  }
  throw new HttpConfigError(
    `Invalid guard in ${where}: ${describe(ref, 'canActivate')}. A guard is an object with canActivate(), a ` +
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

/**
 * Checks that `ref` is middleware: an object with a `use` function, a middleware function, or a
 * class with `use` on its prototype. Anything else (including `undefined` from a circular import,
 * or a class whose `use` is an instance arrow field) is an HttpConfigError naming `where`.
 */
function assertMiddlewareRef(ref: unknown, where: string): asserts ref is MiddlewareRef {
  if (typeof ref === 'function') {
    if (isClassWith(ref, 'use') || !isClass(ref)) return;
  } else if (hasMethod(ref, 'use')) {
    return;
  }
  throw new HttpConfigError(
    `Invalid middleware in ${where}: ${describe(ref, 'use')}. Middleware is an object with ` +
      'use(), a function, or a class with a use() method (not an arrow-function field).',
  );
}

export function resolveMiddleware(
  ref: MiddlewareRef,
  injector: ModuleInjector,
  where = 'a middleware list',
): Middleware {
  assertMiddlewareRef(ref, where);
  if (isClassWith(ref, 'use')) return injector.resolveOrConstruct(ref as Type<Middleware>);
  if (typeof ref === 'function') return { use: ref as MiddlewareFn };
  return ref;
}

/**
 * Checks that `ref` is an exception filter: an object with a `catch` function, or a class with
 * `catch` on its prototype. Anything else (including `undefined` from a circular import, a plain
 * function, or a class whose `catch` is an instance arrow field) is an HttpConfigError naming
 * `where`.
 */
function assertFilterRef(ref: unknown, where: string): asserts ref is FilterRef {
  if (isClassWith(ref, 'catch') || hasMethod(ref, 'catch')) return;
  throw new HttpConfigError(
    `Invalid exception filter in ${where}: ${describe(ref, 'catch')}. A filter is an object ` +
      'with catch(), or a class with a catch() method (not an arrow-function field).',
  );
}

export function resolveFilter(
  ref: FilterRef,
  injector: ModuleInjector,
  where = 'a filter list',
): ExceptionFilter {
  assertFilterRef(ref, where);
  if (isClassWith(ref, 'catch')) return injector.resolveOrConstruct(ref as Type<ExceptionFilter>);
  return ref as ExceptionFilter;
}
