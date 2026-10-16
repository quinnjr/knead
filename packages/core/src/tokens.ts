export type Type<T = unknown> = new (...args: any[]) => T;
export type AbstractType<T = unknown> = abstract new (...args: any[]) => T;

/** A non-class injection token carrying the type of the value it resolves to. */
export class InjectionToken<T> {
  declare readonly __type: T;

  constructor(readonly description: string) {}

  toString(): string {
    return `InjectionToken(${this.description})`;
  }
}

export type Token<T = unknown> = AbstractType<T> | InjectionToken<T>;

export function tokenName(token: unknown): string {
  if (token instanceof InjectionToken) return token.description;
  if (typeof token === 'function') return token.name || '<anonymous class>';
  return String(token);
}

/**
 * Whether the application runs in development: the `development` option of
 * `ApplicationContext.create`, default `NODE_ENV === 'development'`. Injectable from any module.
 */
export const DEVELOPMENT = new InjectionToken<boolean>('DEVELOPMENT');
