import { describe, expect, test } from 'bun:test';
import {
  appendMetadata,
  appendMethodMetadata,
  getMetadata,
  getMethodMetadata,
  getOwnMetadata,
  MetadataKey,
  readMetadata,
  readMethodMetadata,
  setMetadata,
  setMethodMetadata,
} from '../src/index.js';

const TAG = new MetadataKey<string>('tag');
const LIST = new MetadataKey<string[]>('list');
const METHOD_TAG = new MetadataKey<string>('method-tag');
const METHOD_LIST = new MetadataKey<string[]>('method-list');

const tag = (value: string) => (_t: Function, ctx: ClassDecoratorContext) =>
  setMetadata(ctx.metadata, TAG, value);
const push =
  (value: string) => (_t: unknown, ctx: ClassDecoratorContext | ClassMethodDecoratorContext) =>
    appendMetadata(ctx.metadata, LIST, value);
const methodTag = (value: string) => (_m: Function, ctx: ClassMethodDecoratorContext) =>
  setMethodMetadata(ctx.metadata, ctx.name, METHOD_TAG, value);
const methodPush = (value: string) => (_m: Function, ctx: ClassMethodDecoratorContext) =>
  appendMethodMetadata(ctx.metadata, ctx.name, METHOD_LIST, value);

describe('class metadata', () => {
  test('set and get', () => {
    @tag('a')
    class A {}
    expect(getMetadata(A, TAG)).toBe('a');
    expect(getOwnMetadata(A, TAG)).toBe('a');
  });

  test('undecorated classes return undefined', () => {
    class Plain {}
    expect(getMetadata(Plain, TAG)).toBeUndefined();
    expect(getOwnMetadata(Plain, TAG)).toBeUndefined();
  });

  test('subclasses inherit but getOwnMetadata ignores inherited values', () => {
    @tag('parent')
    class Parent {}
    class Child extends Parent {}
    @tag('child')
    class Child2 extends Parent {}
    expect(getMetadata(Child, TAG)).toBe('parent');
    expect(getOwnMetadata(Child, TAG)).toBeUndefined();
    expect(getMetadata(Child2, TAG)).toBe('child');
    expect(getMetadata(Parent, TAG)).toBe('parent');
  });

  test('getOwnMetadata ignores inherited values on a decorated subclass', () => {
    @tag('parent')
    class Parent {}
    @push('c')
    class Child extends Parent {}
    expect(getOwnMetadata(Child, TAG)).toBeUndefined();
    expect(getMetadata(Child, TAG)).toBe('parent');
  });

  test('appending in a subclass never mutates the parent array (Review Focus 3)', () => {
    @push('p1')
    class Parent {}
    @push('c1')
    class Child extends Parent {}
    expect(getMetadata(Parent, LIST)).toEqual(['p1']);
    expect(getMetadata(Child, LIST)).toEqual(['p1', 'c1']);
  });

  test('readMetadata sees inherited values from inside a decorator', () => {
    let seen: string | undefined;
    const spy = (_t: Function, ctx: ClassDecoratorContext) => {
      seen = readMetadata(ctx.metadata, TAG);
    };
    @tag('base')
    class Base {}
    @spy
    class Derived extends Base {}
    expect(seen).toBe('base');
    expect(Derived).toBeDefined();
  });
});

describe('method metadata', () => {
  test('is stored per method', () => {
    class C {
      @methodTag('one') one() {}
      @methodTag('two') two() {}
    }
    expect(getMethodMetadata(C, 'one', METHOD_TAG)).toBe('one');
    expect(getMethodMetadata(C, 'two', METHOD_TAG)).toBe('two');
    expect(getMethodMetadata(C, 'three', METHOD_TAG)).toBeUndefined();
  });

  test('multiple decorators on one method append in application order (bottom-up)', () => {
    class C {
      @methodPush('outer')
      @methodPush('inner')
      m() {}
    }
    expect(getMethodMetadata(C, 'm', METHOD_LIST)).toEqual(['inner', 'outer']);
  });

  test('subclass method metadata does not leak into the parent', () => {
    class Parent {
      @methodPush('p') m() {}
    }
    class Child extends Parent {
      @methodPush('c') override m() {}
      @methodTag('only-child') extra() {}
    }
    expect(getMethodMetadata(Parent, 'm', METHOD_LIST)).toEqual(['p']);
    expect(getMethodMetadata(Child, 'm', METHOD_LIST)).toEqual(['p', 'c']);
    expect(getMethodMetadata(Parent, 'extra', METHOD_TAG)).toBeUndefined();
    expect(getMethodMetadata(Child, 'extra', METHOD_TAG)).toBe('only-child');
  });

  test('readMethodMetadata reads inside a decorator', () => {
    let seen: string | undefined;
    const spy = (_m: Function, ctx: ClassMethodDecoratorContext) => {
      seen = readMethodMetadata(ctx.metadata, ctx.name, METHOD_TAG);
    };
    class C {
      @spy
      @methodTag('x')
      m() {}
    }
    expect(seen).toBe('x');
    expect(C).toBeDefined();
  });
});
