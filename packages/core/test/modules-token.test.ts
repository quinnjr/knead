import { describe, expect, test } from 'bun:test';
import { ApplicationContext, InjectionToken, inject, MODULES, Module } from '../src/index.js';

describe('MODULES token', () => {
  test('every provider can inject the module list in initialization order', async () => {
    const SEEN = new InjectionToken<string[]>('SEEN');
    @Module({
      providers: [{ provide: SEEN, useFactory: () => inject(MODULES).map((m) => m.name) }],
      exports: [SEEN],
    })
    class Child {}
    @Module({ imports: [Child] })
    class Root {}
    const ctx = await ApplicationContext.create(Root);
    expect(ctx.get(SEEN)).toEqual(['Child', 'Root']);
    expect(ctx.get(MODULES).map((m) => m.metatype)).toEqual([Child, Root]);
  });

  test('the list is frozen', async () => {
    @Module({})
    class Root {}
    const ctx = await ApplicationContext.create(Root);
    expect(Object.isFrozen(ctx.get(MODULES))).toBe(true);
  });

  test('a module provider overriding MODULES is respected through overrides', async () => {
    @Module({})
    class Root {}
    const ctx = await ApplicationContext.create(Root, {
      overrides: [[MODULES, { provide: MODULES, useValue: [] }]],
    });
    expect(ctx.get(MODULES)).toEqual([]);
  });
});
