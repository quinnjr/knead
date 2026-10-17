import { describe, expect, test } from 'bun:test';
import { definePermissions, MAX_SCOPE_LENGTH, parseGrant } from '../src/index.js';

const p = definePermissions({
  posts: {
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: ['create', 'update', 'delete'], subject: 'Post' }],
    },
  },
  billing: {
    description: 'Invoices',
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }] },
  },
});

describe('parseGrant', () => {
  test('object form', () => {
    expect(parseGrant({ posts: 'write' }, p)).toEqual({ posts: 'write' });
  });

  test('scope string and array', () => {
    const expected = { posts: 'read', billing: 'read' };
    expect(parseGrant('posts:read  billing:read', p)).toEqual(expected);
    expect(parseGrant(['posts:read', 'billing:read'], p)).toEqual(expected);
  });

  test('result is frozen and null-prototype', () => {
    const g = parseGrant({ posts: 'read' }, p)!;
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.getPrototypeOf(g)).toBeNull();
  });

  test('empty grant denies without being malformed', () => {
    for (const input of [{}, '', [], '   ']) {
      const g = parseGrant(input, p);
      expect(g).not.toBeNull();
      expect(g).toEqual({});
    }
    expect(Object.keys(parseGrant({}, p)!)).toEqual([]);
  });

  test('malformed returns null', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      { posts: 'admin' },
      { nope: 'read' },
      'posts',
      'posts:read posts:write',
      { posts: 1 },
      'a'.repeat(MAX_SCOPE_LENGTH + 1),
      ['posts:read', 'billing:read', 'posts:write'],
      [42],
      ['posts:read', 'posts:read'],
      'posts:read:write',
      '__proto__:read',
      'constructor:read',
      'prototype:read',
      ['constructor:read'],
    ];
    for (const input of inputs) expect(parseGrant(input, p)).toBeNull();
  });

  test('ignores prototype keys', () => {
    const input = JSON.parse('{"__proto__":{"posts":"write"},"billing":"read"}');
    expect(parseGrant(input, p)).toEqual({ billing: 'read' });
    expect(({} as any).posts).toBeUndefined();
    expect(parseGrant({ constructor: 'read', prototype: 'read', posts: 'read' }, p)).toEqual({
      posts: 'read',
    });
  });

  test('object form stops reading once it has more pairs than areas', () => {
    let reads = 0;
    const target = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`a${i}`, 'read']));
    const input = new Proxy(target, {
      get(t, key) {
        reads++;
        return Reflect.get(t, key);
      },
    });
    expect(parseGrant(input, p)).toBeNull();
    expect(reads).toBeLessThanOrEqual(Object.keys(p.areas).length + 1);
  });

  test('linear on adversarial input', () => {
    const inputs: unknown[] = [
      `${' '.repeat(4000)}x`,
      'a:'.repeat(2000),
      'posts:read '.repeat(370),
      Array(5000).fill('posts:read'),
      Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`a${i}`, 1])),
      Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`a${i}`, 'read'])),
    ];
    for (const input of inputs) {
      const start = performance.now();
      expect(parseGrant(input, p)).toBeNull();
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});
