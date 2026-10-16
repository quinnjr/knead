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
});

describe('errors', () => {
  test('CircularDependencyError formats the path', () => {
    const e = new CircularDependencyError(['A', 'B', 'A']);
    expect(e.message).toBe('Circular dependency detected: A → B → A');
    expect(e.path).toEqual(['A', 'B', 'A']);
    expect(e.name).toBe('CircularDependencyError');
  });
});
