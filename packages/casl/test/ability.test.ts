import { expect, test } from 'bun:test';
import type { MongoAbility, RawRuleOf } from '@casl/ability';
import { asSubject, createAppAbility, grantRules, intersectRules } from '../src/ability.js';
import { definePermissions } from '../src/permissions.js';

type Rule = RawRuleOf<MongoAbility>;

const p = definePermissions({
  posts: {
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: ['create', 'update', 'delete'], subject: 'Post' }],
    },
  },
  billing: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }] },
  },
});

const effective = (user: Rule[], grant: Record<string, string>) =>
  createAppAbility(intersectRules(user, grantRules(grant, p)));

test('owner-only update survives a write grant', () => {
  const a = effective([{ action: 'update', subject: 'Post', conditions: { authorId: 'u1' } }], {
    posts: 'write',
  });
  expect(a.can('update', asSubject('Post', { authorId: 'u1' }))).toBe(true);
  expect(a.can('update', asSubject('Post', { authorId: 'u2' }))).toBe(false);
});

test('manage/all user is narrowed by grant', () => {
  const a = effective([{ action: 'manage', subject: 'all' }], { posts: 'read' });
  expect(a.can('read', 'Post')).toBe(true);
  expect(a.can('update', 'Post')).toBe(false);
  expect(a.can('read', 'User')).toBe(false);
});

test('grant never widens', () => {
  const a = effective([{ action: 'read', subject: 'Post' }], { posts: 'write' });
  expect(a.can('read', 'Post')).toBe(true);
  expect(a.can('delete', 'Post')).toBe(false);
});

test('empty grant → no rules', () => {
  const userRules: Rule[] = [
    { action: 'manage', subject: 'all' },
    { action: 'read', subject: 'Post' },
  ];
  expect(intersectRules(userRules, grantRules({}, p))).toEqual([]);
});

test('field intersection', () => {
  for (const fields of [undefined, ['billing*']]) {
    const a = effective([{ action: 'read', subject: 'User', ...(fields && { fields }) }], {
      billing: 'read',
    });
    expect(a.can('read', 'User', 'billingAddress')).toBe(true);
    expect(a.can('read', 'User', 'email')).toBe(false);
  }
  expect(
    intersectRules(
      [{ action: 'read', subject: 'User', fields: ['email'] }],
      grantRules({ billing: 'read' }, p),
    ),
  ).toEqual([]);
});

test('inverted user rules still apply', () => {
  const a = effective(
    [
      { action: 'manage', subject: 'all' },
      { action: 'delete', subject: 'Post', conditions: { locked: true }, inverted: true },
    ],
    { posts: 'write' },
  );
  expect(a.can('delete', asSubject('Post', { locked: true }))).toBe(false);
  expect(a.can('delete', asSubject('Post', { locked: false }))).toBe(true);
});

test('asSubject does not mutate', () => {
  const r = Object.freeze({ authorId: 'u1' });
  expect(asSubject('Post', r)).toBe(r);
  expect(Reflect.ownKeys(r)).toEqual(['authorId']);
});
