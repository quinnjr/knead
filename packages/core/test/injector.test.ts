import { describe, expect, test } from 'bun:test';
import {
  CircularDependencyError,
  Injectable,
  InjectionContextError,
  InjectionToken,
  inject,
  NoProviderError,
  normalizeProvider,
  type Provider,
  ProviderConfigError,
} from '../src/index.js';
import { ContainerState, ModuleInjector } from '../src/injector.js';

function injectorWith(...providers: Provider[]): ModuleInjector {
  const injector = new ModuleInjector('TestModule', new ContainerState());
  for (const p of providers) injector.addProvider(normalizeProvider(p));
  return injector;
}

class Db {
  readonly id = Math.random();
}
class Repo {
  readonly db = inject(Db);
}
const URL_TOKEN = new InjectionToken<string>('URL');
const CONN = new InjectionToken<{ url: string }>('CONN');
const LIST = new InjectionToken<string[]>('LIST');

describe('ModuleInjector', () => {
  test('resolves field-initializer dependencies', () => {
    const injector = injectorWith(Db, Repo);
    const repo = injector.get(Repo)!;
    expect(repo.db).toBeInstanceOf(Db);
    expect(repo.db).toBe(injector.get(Db)!);
  });

  test('singletons are cached', () => {
    const injector = injectorWith(Db);
    expect(injector.get(Db)).toBe(injector.get(Db)!);
  });

  test('transient providers create a new instance per resolution', () => {
    @Injectable({ scope: 'transient' })
    class Fresh {}
    const injector = injectorWith(Fresh);
    expect(injector.get(Fresh)).not.toBe(injector.get(Fresh)!);
  });

  test('factories can inject', () => {
    const injector = injectorWith(
      { provide: URL_TOKEN, useValue: 'db://x' },
      { provide: CONN, useFactory: () => ({ url: inject(URL_TOKEN) }) },
    );
    expect(injector.get(CONN)).toEqual({ url: 'db://x' });
  });

  test('useExisting aliases the same instance', () => {
    abstract class Store {}
    class MemoryStore extends Store {}
    const injector = injectorWith(MemoryStore, { provide: Store, useExisting: MemoryStore });
    expect(injector.get(Store)).toBe(injector.get(MemoryStore)!);
  });

  test('optional injection returns undefined when missing', () => {
    class UsesOptional {
      readonly url = inject(URL_TOKEN, { optional: true });
    }
    expect(injectorWith(UsesOptional).get(UsesOptional)!.url).toBeUndefined();
  });

  test('missing providers throw NoProviderError naming requester and module', () => {
    const injector = injectorWith(Repo);
    expect(() => injector.get(Repo)).toThrow(NoProviderError);
    expect(() => injector.get(Repo)).toThrow(
      'Repo (TestModule) requested Db, but no provider is visible. No module provides Db. ' +
        'Add it to the providers of TestModule or of a module that TestModule imports.',
    );
  });

  test('inject() outside an injection context throws', () => {
    expect(() => inject(Db)).toThrow(InjectionContextError);
    expect(() => new Repo()).toThrow(InjectionContextError);
  });

  test('the outside-context error message is exact', () => {
    expect(() => inject(Db)).toThrow(
      'inject(Db) was called outside an injection context. inject() only works synchronously inside field initializers, constructors and provider factories; call it before the first await.',
    );
  });

  test('multi providers resolve to an array in registration order', () => {
    const injector = injectorWith(
      { provide: LIST, useValue: 'a', multi: true },
      { provide: LIST, useFactory: () => 'b', multi: true },
    );
    expect(injector.get(LIST)).toEqual(['a', 'b']);
  });

  test('mixing multi and non-multi registrations is an error', () => {
    expect(() =>
      injectorWith(
        { provide: LIST, useValue: 'a', multi: true },
        { provide: LIST, useValue: ['b'] },
      ),
    ).toThrow(ProviderConfigError);
  });

  test('a later non-multi registration replaces an earlier one', () => {
    const injector = injectorWith(
      { provide: URL_TOKEN, useValue: 'first' },
      { provide: URL_TOKEN, useValue: 'second' },
    );
    expect(injector.get(URL_TOKEN)).toBe('second');
  });

  test('cycles throw CircularDependencyError with the full path', () => {
    class A {
      readonly b: unknown = inject(B);
    }
    class B {
      readonly a: unknown = inject(A);
    }
    const injector = injectorWith(A, B);
    expect(() => injector.get(A)).toThrow(CircularDependencyError);
    expect(() => injector.get(A)).toThrow('Circular dependency detected: A → B → A');
  });

  test('a self-referencing alias is a cycle', () => {
    const SELF = new InjectionToken<unknown>('SELF');
    expect(() => injectorWith({ provide: SELF, useExisting: SELF }).get(SELF)).toThrow(
      'Circular dependency detected: SELF → SELF',
    );
  });

  test('a constructor that throws leaves the record retryable', () => {
    let fail = true;
    class Flaky {
      constructor() {
        if (fail) throw new Error('boom');
      }
    }
    const injector = injectorWith(Flaky);
    expect(() => injector.get(Flaky)).toThrow('boom');
    fail = false;
    expect(injector.get(Flaky)).toBeInstanceOf(Flaky);
  });
});
