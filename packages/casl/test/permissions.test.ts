import { describe, expect, test } from 'bun:test';
import { CaslConfigError, type Catalog, definePermissions, fullGrant } from '../src/index.js';

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

test('rulesFor is cumulative', () => {
  expect(p.rulesFor('posts', 'write')).toEqual([
    { action: 'read', subject: 'Post' },
    { action: ['create', 'update', 'delete'], subject: 'Post' },
  ]);
  expect(p.rulesFor('posts', 'none')).toEqual([]);
});

test('rulesFor includes fields and denies unknown levels', () => {
  expect(p.rulesFor('billing', 'read')).toEqual([
    { action: 'read', subject: 'User', fields: ['billingAddress'] },
  ]);
  expect(p.rulesFor('posts', 'bogus')).toEqual([]);
  expect(p.rulesFor('nope' as any, 'read')).toEqual([]);
});

test('describe is JSON-safe and frozen', () => {
  expect(p.describe()).toEqual({
    areas: [
      { name: 'posts', levels: ['none', 'read', 'write'] },
      { name: 'billing', description: 'Invoices', levels: ['none', 'read'] },
    ],
  });
  expect(p.describe()).toBe(p.describe());
  expect(Object.isFrozen(p.describe().areas[0])).toBe(true);
  expect(Object.isFrozen(p.describe().areas[0]!.levels)).toBe(true);
  expect(Object.isFrozen(p.areas.posts.rules.read![0])).toBe(true);
  expect(JSON.parse(JSON.stringify(p.describe()))).toEqual(p.describe());
});

test('fullGrant picks the highest level', () =>
  expect(fullGrant(p)).toEqual({ posts: 'write', billing: 'read' }));

test('input is copied: later mutation has no effect', () => {
  const src = {
    a: { levels: ['none', 'read'], rules: { read: [{ action: 'read', subject: 'X' }] } },
  };
  const q = definePermissions(src as unknown as Catalog);
  src.a.levels.push('write');
  src.a.rules.read[0]!.action = 'delete';
  expect(q.rulesFor('a', 'read')).toEqual([{ action: 'read', subject: 'X' }]);
  expect(fullGrant(q)).toEqual({ a: 'read' });
});

const ok = { action: 'read', subject: 'Post' };
const area = (over: Record<string, unknown> = {}) => ({
  levels: ['none', 'read'],
  rules: { read: [ok] },
  ...over,
});

describe('invalid catalogs throw CaslConfigError', () => {
  const cases: [string, unknown][] = [
    ['empty catalog', {}],
    ['bad area name', { Posts: area() }],
    ['area name too long', { [`a${'b'.repeat(64)}`]: area() }],
    ['empty levels', { a: area({ levels: [], rules: {} }) }],
    ['duplicate level', { a: area({ levels: ['none', 'read', 'read'] }) }],
    ['bad level name', { a: area({ levels: ['none', 'Read'], rules: { Read: [ok] } }) }],
    ['rules key not in levels', { a: area({ rules: { read: [ok], extra: [ok] } }) }],
    ['rules on levels[0]', { a: area({ rules: { none: [ok], read: [ok] } }) }],
    [
      'non-final level with no rules',
      { a: area({ levels: ['none', 'read', 'write'], rules: { write: [ok] } }) },
    ],
    ['final level with no rules', { a: area({ rules: {} }) }],
    ['conditions', { a: area({ rules: { read: [{ ...ok, conditions: { id: 1 } }] } }) }],
    ['inverted', { a: area({ rules: { read: [{ ...ok, inverted: true }] } }) }],
    ['reason', { a: area({ rules: { read: [{ ...ok, reason: 'no' }] } }) }],
    ['empty action', { a: area({ rules: { read: [{ ...ok, action: '' }] } }) }],
    ['empty action list', { a: area({ rules: { read: [{ ...ok, action: [] }] } }) }],
    ['empty subject', { a: area({ rules: { read: [{ ...ok, subject: '' }] } }) }],
    ['empty fields', { a: area({ rules: { read: [{ ...ok, fields: [] }] } }) }],
    ['wildcard field', { a: area({ rules: { read: [{ ...ok, fields: ['a*'] }] } }) }],
    ['__proto__ area', JSON.parse('{"__proto__": {"levels":["none","read"],"rules":{}}}')],
  ];
  test.each(cases)('%s', (_name, catalog) => {
    expect(() => definePermissions(catalog as Catalog)).toThrow(CaslConfigError);
  });
});
