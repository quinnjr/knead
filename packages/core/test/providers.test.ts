import { describe, expect, test } from 'bun:test';
import {
  CircularDependencyError,
  getMetadata,
  INJECTABLE,
  Injectable,
  InjectionToken,
  MODULE_METADATA,
  Module,
  normalizeProvider,
  ProviderConfigError,
  tokenName,
} from '../src/index.js';

const CONFIG = new InjectionToken<{ url: string }>('CONFIG');

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
