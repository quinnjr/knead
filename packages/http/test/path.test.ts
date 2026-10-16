import { describe, expect, test } from 'bun:test';
import { compileMatcher, joinPaths, routeShape } from '../src/path.js';

describe('joinPaths', () => {
  test.each([
    [['', ''], '/'],
    [['/users', '/'], '/users'],
    [['users', ':id'], '/users/:id'],
    [['/api/', '/users/', ''], '/api/users'],
    [['//a//', 'b'], '/a/b'],
  ])('%p → %p', (parts, expected) => {
    expect(joinPaths(...parts)).toBe(expected);
  });
});

test('routeShape erases parameter names', () => {
  expect(routeShape('/users/:id/posts/:postId')).toBe('/users/:/posts/:');
});

test('compileMatcher matches one segment per param and escapes literals', () => {
  expect(compileMatcher('/users/:id').test('/users/42')).toBe(true);
  expect(compileMatcher('/users/:id').test('/users/42/x')).toBe(false);
  expect(compileMatcher('/users/:id').test('/users/')).toBe(false);
  expect(compileMatcher('/a.b').test('/aXb')).toBe(false);
  expect(compileMatcher('/static/*').test('/static/a/b.css')).toBe(true);
});

test('compileMatcher: a mid-path wildcard spans multiple segments', () => {
  expect(compileMatcher('/a/*/b').test('/a/x/y/b')).toBe(true);
});

test('compileMatcher: regex characters in literal segments are escaped', () => {
  const m = compileMatcher('/v1.0/(x)');
  expect(m.test('/v1.0/(x)')).toBe(true);
  expect(m.test('/v1x0/x')).toBe(false);
});
