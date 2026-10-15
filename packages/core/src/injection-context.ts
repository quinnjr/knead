import { InjectionContextError } from './errors.js';
import type { Token } from './tokens.js';

export interface InjectOptions {
  optional?: boolean;
}

export interface InjectorLike {
  get<T>(token: Token<T>, options?: InjectOptions): T | undefined;
}

let current: InjectorLike | undefined;

export function runInInjectionContext<R>(injector: InjectorLike, fn: () => R): R {
  const previous = current;
  current = injector;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

export function isInInjectionContext(): boolean {
  return current !== undefined;
}

export function inject<T>(token: Token<T>): T;
export function inject<T>(token: Token<T>, options: { optional: true }): T | undefined;
export function inject<T>(token: Token<T>, options?: InjectOptions): T | undefined {
  if (!current) throw new InjectionContextError(token);
  return current.get(token, options);
}
