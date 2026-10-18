import { INJECTABLE } from './decorators.js';
import { ProviderConfigError } from './errors.js';
import { getMetadata } from './metadata.js';
import { checkScope, describe } from './provider-checks.js';
import { type Token, type Type, tokenName } from './tokens.js';

export type Scope = 'singleton' | 'transient';

type Provide<T> = { provide: Token<T>; multi?: false } | { provide: Token<T[]>; multi: true };

export type ClassProvider<T = any> = Provide<T> & { useClass: Type<T>; scope?: Scope };
export type ValueProvider<T = any> = Provide<T> & { useValue: T };
export type FactoryProvider<T = any> = Provide<T> & {
  useFactory: () => T | Promise<T>;
  scope?: Scope;
};
export type ExistingProvider<T = any> = Provide<T> & { useExisting: Token<T> };

export type Provider<T = any> =
  | Type<T>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;

export type NormalizedProvider =
  | { kind: 'class'; token: Token; useClass: Type; scope: Scope; multi: boolean }
  | { kind: 'value'; token: Token; value: unknown; scope: 'singleton'; multi: boolean }
  | { kind: 'factory'; token: Token; factory: () => unknown; scope: Scope; multi: boolean }
  | { kind: 'existing'; token: Token; existing: Token; scope: 'singleton'; multi: boolean };

/** The class's @Injectable scope, or undefined when the class is not marked injectable. */
function injectableScope(cls: Type): Scope | undefined {
  return getMetadata(cls, INJECTABLE)?.scope;
}

/**
 * Validates and normalizes a provider. `owner` names the module (or other source) declaring it in
 * error messages. Classes the container constructs must be marked with @Injectable().
 */
export function normalizeProvider(
  provider: Provider,
  owner = 'the application',
): NormalizedProvider {
  if (typeof provider === 'function') {
    const scope = injectableScope(provider);
    if (scope === undefined) {
      throw new ProviderConfigError(
        `${tokenName(provider)} is listed in the providers of ${owner} but is not decorated with @Injectable().`,
      );
    }
    return { kind: 'class', token: provider, useClass: provider, scope, multi: false };
  }
  if (provider === null || typeof provider !== 'object' || !('provide' in provider)) {
    throw new ProviderConfigError(
      `Invalid provider: ${describe(provider)}. Expected a class or an object with "provide".`,
    );
  }
  const token = provider.provide as Token;
  const multi = provider.multi === true;
  if ('useClass' in provider) {
    const useClass = provider.useClass as Type;
    const marked = injectableScope(useClass);
    if (marked === undefined) {
      throw new ProviderConfigError(
        `The provider for ${tokenName(token)} in ${owner} uses ${tokenName(useClass)}, which is not decorated with @Injectable().`,
      );
    }
    const scope =
      provider.scope === undefined ? marked : checkScope(provider.scope, tokenName(token));
    return { kind: 'class', token, useClass, scope, multi };
  }
  if ('useValue' in provider) {
    return { kind: 'value', token, value: provider.useValue, scope: 'singleton', multi };
  }
  if ('useFactory' in provider) {
    const factory = provider.useFactory as () => unknown;
    const scope =
      provider.scope === undefined ? 'singleton' : checkScope(provider.scope, tokenName(token));
    return { kind: 'factory', token, factory, scope, multi };
  }
  if ('useExisting' in provider) {
    return {
      kind: 'existing',
      token,
      existing: provider.useExisting as Token,
      scope: 'singleton',
      multi,
    };
  }
  throw new ProviderConfigError(
    `Provider for ${tokenName(token)} must define useClass, useValue, useFactory or useExisting.`,
  );
}
