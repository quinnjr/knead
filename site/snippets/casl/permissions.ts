import { definePermissions, fullGrant } from '@knead-js/casl';

// #region catalog
export const permissions = definePermissions({
  posts: {
    description: 'Blog posts',
    levels: ['none', 'read', 'write', 'manage'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: ['create', 'update'], subject: 'Post' }],
      manage: [{ action: 'delete', subject: 'Post' }],
    },
  },
  users: {
    description: 'User profiles',
    levels: ['none', 'read'],
    rules: {
      read: [{ action: 'read', subject: 'User', fields: ['id', 'name', 'email'] }],
    },
  },
  billing: {
    description: 'Billing details',
    levels: ['none', 'read'],
    rules: {
      read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }],
    },
  },
});
// #endregion catalog

// #region describe
// A JSON-safe list of areas and levels, for example for a token-issuing screen.
export const catalogForClients = permissions.describe();
// { areas: [{ name: 'posts', description: 'Blog posts', levels: ['none', 'read', 'write', 'manage'] }, ...] }

// The cumulative CASL raw rules of one level: posts:write includes posts:read.
export const writeRules = permissions.rulesFor('posts', 'write');
// [{ action: 'read', subject: 'Post' }, { action: ['create', 'update'], subject: 'Post' }]
// #endregion describe

// #region full-grant
// Every area at its highest level, for a first-party session.
export const everything = fullGrant(permissions);
// { posts: 'manage', users: 'read', billing: 'read' }
// #endregion full-grant
