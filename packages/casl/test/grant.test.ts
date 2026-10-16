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
    ];
    for (const input of inputs) expect(parseGrant(input, p)).toBeNull();
  });

  test('ignores prototype keys', () => {
    const input = JSON.parse('{"__proto__":{"posts":"write"},"billing":"read"}');
    expect(parseGrant(input, p)).toEqual({ billing: 'read' });
    expect(({} as any).posts).toBeUndefined();
  });

  test('linear on adversarial input', () => {
    for (const input of [' '.repeat(4000) + 'x', 'a:'.repeat(2000)]) {
      const start = performance.now();
      parseGrant(input, p);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});
