import { describe, expect, test } from 'bun:test';
import {
  ApplicationContext,
  CircularDependencyError,
  getMetadata,
  INJECTABLE,
  Injectable,
  InjectionToken,
  MODULE_METADATA,
  Module,
  markInjectable,
  normalizeProvider,
  ProviderConfigError,
  tokenName,
} from '../src/index.js';

const CONFIG = new InjectionToken<{ url: string }>('CONFIG');

@Injectable()
class Plain {}
@Injectable({ scope: 'transient' })
class Transient {}

describe('tokenName', () => {
  test('names classes, tokens and anonymous classes', () => {
    expect(tokenName(Plain)).toBe('Plain');
    expect(tokenName(CONFIG)).toBe('CONFIG');
    expect(tokenName(class {})).toBe('<anonymous class>');
    expect(String(CONFIG)).toBe('InjectionToken(CONFIG)');
  });
});

describe('@Injectable', () => {
  test('stores scope metadata, defaulting to singleton', () => {
    @Injectable()
    class S {}
    expect(getMetadata(S, INJECTABLE)).toEqual({ scope: 'singleton' });
    expect(getMetadata(Transient, INJECTABLE)).toEqual({ scope: 'transient' });
  });
});

describe('@Module', () => {
  test('stores module options', () => {
    @Module({ providers: [Plain], exports: [Plain] })
    class M {}
    expect(getMetadata(M, MODULE_METADATA)).toEqual({ providers: [Plain], exports: [Plain] });
  });
});

describe('normalizeProvider', () => {
  test('class shorthand reads @Injectable scope', () => {
    expect(normalizeProvider(Plain)).toEqual({
      kind: 'class',
      token: Plain,
      useClass: Plain,
      scope: 'singleton',
      multi: false,
    });
    expect(normalizeProvider(Transient)).toMatchObject({ kind: 'class', scope: 'transient' });
  });

  test('useClass, useValue, useFactory, useExisting', () => {
    expect(normalizeProvider({ provide: Plain, useClass: Transient })).toMatchObject({
      kind: 'class',
      token: Plain,
      useClass: Transient,
      scope: 'transient',
      multi: false,
    });
    expect(normalizeProvider({ provide: CONFIG, useValue: { url: 'x' } })).toEqual({
      kind: 'value',
      token: CONFIG,
      value: { url: 'x' },
      scope: 'singleton',
      multi: false,
    });
    const factory = () => ({ url: 'y' });
    expect(normalizeProvider({ provide: CONFIG, useFactory: factory, scope: 'transient' })).toEqual(
      {
        kind: 'factory',
        token: CONFIG,
        factory,
        scope: 'transient',
        multi: false,
      },
    );
    expect(normalizeProvider({ provide: Transient, useExisting: Plain })).toEqual({
      kind: 'existing',
      token: Transient,
      existing: Plain,
      scope: 'singleton',
      multi: false,
    });
  });

  test('multi providers', () => {
    const LIST = new InjectionToken<string[]>('LIST');
    expect(normalizeProvider({ provide: LIST, useValue: 'a', multi: true })).toMatchObject({
      kind: 'value',
      multi: true,
    });
  });

  test('invalid providers throw ProviderConfigError', () => {
    expect(() => normalizeProvider({ provide: CONFIG } as never)).toThrow(ProviderConfigError);
    expect(() => normalizeProvider(42 as never)).toThrow(/Invalid provider: 42/);
  });

  test('a malformed provide, useClass, useFactory or useExisting is a ProviderConfigError', () => {
    const cases: [unknown, RegExp][] = [
      [{ provide: undefined, useValue: 1 }, /provide is undefined.*circular file import/],
      [{ provide: 'CONFIG', useValue: 1 }, /provide must be a class or an InjectionToken/],
      [{ provide: CONFIG, useClass: undefined }, /CONFIG.*useClass is undefined.*circular/],
      [{ provide: CONFIG, useClass: {} }, /CONFIG.*useClass must be a class/],
      [{ provide: CONFIG, useFactory: 42 }, /CONFIG.*useFactory must be a function/],
      [{ provide: CONFIG, useExisting: undefined }, /CONFIG.*useExisting is undefined.*circular/],
      [{ provide: CONFIG, useExisting: 'X' }, /CONFIG.*useExisting must be a class or/],
    ];
    for (const [provider, message] of cases) {
      expect(() => normalizeProvider(provider as never, 'AppModule')).toThrow(ProviderConfigError);
      expect(() => normalizeProvider(provider as never, 'AppModule')).toThrow(message);
    }
  });

  test('malformed provider messages, as documented', () => {
    const MAILER = new InjectionToken<unknown>('MAILER');
    const CLOCK = new InjectionToken<unknown>('CLOCK');
    expect(() =>
      normalizeProvider({ provide: MAILER, useClass: undefined as never }, 'AppModule'),
    ).toThrow(
      'The provider for MAILER in AppModule: useClass is undefined. This usually means a circular file import; check the import order of your files.',
    );
    expect(() =>
      normalizeProvider({ provide: CLOCK, useFactory: 42 as never }, 'AppModule'),
    ).toThrow('The provider for CLOCK in AppModule: useFactory must be a function, got 42.');
  });

  test('a malformed provider fails when the module graph is built', async () => {
    @Module({ providers: [{ provide: CONFIG, useClass: undefined as never }] })
    class Root {}
    await expect(ApplicationContext.create(Root)).rejects.toThrow(ProviderConfigError);
  });

  test('an invalid provider message names its keys, never its values', () => {
    let message = '';
    try {
      normalizeProvider({ provde: CONFIG, useValue: 'postgres://u:pw@h/db' } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('provde');
    expect(message).toContain('useValue');
    expect(message).not.toContain('pw@');
    expect(message).not.toContain('postgres://');
  });

  test('an invalid provider message is bounded and redacted', () => {
    const many = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]));
    expect(() => normalizeProvider(many as never)).toThrow(ProviderConfigError);
    try {
      normalizeProvider(many as never);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(600);
    }
    try {
      normalizeProvider('redis://u:strsecret@h' as never);
    } catch (error) {
      expect((error as Error).message).not.toContain('strsecret');
    }
  });
});

describe('errors', () => {
  test('CircularDependencyError formats the path', () => {
    const e = new CircularDependencyError(['A', 'B', 'A']);
    expect(e.message).toBe('Circular dependency detected: A → B → A');
    expect(e.path).toEqual(['A', 'B', 'A']);
    expect(e.name).toBe('CircularDependencyError');
  });
});

describe('@Injectable is required', () => {
  class Unmarked {}

  test('a class provider without @Injectable fails, naming the class and module', () => {
    expect(() => normalizeProvider(Unmarked, 'AppModule')).toThrow(ProviderConfigError);
    expect(() => normalizeProvider(Unmarked, 'AppModule')).toThrow(
      'Unmarked is listed in the providers of AppModule but is not decorated with @Injectable().',
    );
  });

  test('a useClass provider without @Injectable fails', () => {
    expect(() => normalizeProvider({ provide: CONFIG, useClass: Unmarked }, 'AppModule')).toThrow(
      'The provider for CONFIG in AppModule uses Unmarked, which is not decorated with @Injectable().',
    );
  });

  test('value, factory and existing providers need no decorator', () => {
    expect(() => normalizeProvider({ provide: Unmarked, useValue: new Unmarked() })).not.toThrow();
    expect(() =>
      normalizeProvider({ provide: Unmarked, useFactory: () => new Unmarked() }),
    ).not.toThrow();
    expect(() => normalizeProvider({ provide: CONFIG, useExisting: Unmarked })).not.toThrow();
  });

  test('markInjectable marks a class for framework decorators without overriding a scope', () => {
    const Marked = (() => {
      @Injectable({ scope: 'transient' })
      @((_t: Function, c: ClassDecoratorContext) => markInjectable(c.metadata))
      class Marked {}
      return Marked;
    })();
    expect(getMetadata(Marked, INJECTABLE)).toEqual({ scope: 'transient' });

    @Injectable({ scope: 'transient' })
    class Inner {}
    const Outer = (() => {
      @((_t: Function, c: ClassDecoratorContext) => markInjectable(c.metadata))
      class Outer extends Inner {}
      return Outer;
    })();
    expect(getMetadata(Outer, INJECTABLE)).toEqual({ scope: 'transient' });
  });

  test('bootstrap fails on an unmarked provider', async () => {
    @Module({ providers: [Unmarked] })
    class AppModule {}
    await expect(ApplicationContext.create(AppModule)).rejects.toThrow(
      'Unmarked is listed in the providers of AppModule but is not decorated with @Injectable().',
    );
  });

  test('guard, middleware and filter classes need no decorator', async () => {
    @Module({})
    class AppModule {}
    const ctx = await ApplicationContext.create(AppModule);
    expect(ctx.root.injector.resolveOrConstruct(Unmarked)).toBeInstanceOf(Unmarked);
    await ctx.close();
  });
});
