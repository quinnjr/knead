import { describe, expect, test } from 'bun:test';
import { compileMatcher, compilePathIndex, joinPaths, routeShape } from '../src/path.js';

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

describe('compilePathIndex', () => {
  const patterns = [
    '/',
    '/users',
    '/users/:id',
    '/users/:id/posts',
    '/:any',
    '/:a/:b',
    '/files/*',
    '/*',
    '/a.b',
    '/x/:y/z',
  ];
  const paths = [
    '/',
    '/users',
    '/users/',
    '/users/1',
    '/users/1/posts',
    '/users/1/posts/2',
    '/files',
    '/files/',
    '/files/a/b',
    '/a.b',
    '/aXb',
    '/x/1/z',
    '/x//z',
    '//',
    '/q',
    '',
  ];

  test('finds exactly the patterns whose matcher accepts the path', () => {
    const lookup = compilePathIndex(patterns.map((p) => [p, p] as const));
    for (const path of paths) {
      const expected = patterns.filter((p) => compileMatcher(p).test(path)).sort();
      expect([...lookup(path)].sort()).toEqual(expected);
    }
  });

  test('a lookup among 10k routes runs only the plausible matchers', () => {
    const lookup = compilePathIndex(
      Array.from({ length: 10_000 }, (_, i) => [`/r${i}/:id`, i] as const),
    );
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) lookup(`/missing${i}/x`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(lookup('/r42/7')).toEqual([42]);
  });
});
