import type { ModuleInjector, Type } from '@hpmws/core';
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

export function resolveGuard(ref: GuardRef<any>, injector: ModuleInjector): Guard<any> {
  if (isClassWith(ref, 'canActivate')) return injector.resolveOrConstruct(ref as Type<Guard<any>>);
  if (typeof ref === 'function') return { canActivate: ref as GuardFn<Ctx> };
  return ref;
}

export function resolveFilter(ref: FilterRef, injector: ModuleInjector): ExceptionFilter {
  if (isClassWith(ref, 'catch')) return injector.resolveOrConstruct(ref as Type<ExceptionFilter>);
  return ref as ExceptionFilter;
}
