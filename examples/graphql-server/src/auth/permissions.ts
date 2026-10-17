import type { CaslModuleOptions } from '@knead-js/casl';
import { definePermissions } from '@knead-js/casl';
import type { CurrentUser } from './auth.js';

/**
 * What a token may be granted, area by area. Levels are cumulative (`write` includes `read`), and
 * the first level means no access. Reading published posts needs no token at all.
 */
export const permissions = definePermissions({
  blog: {
    description: 'Posts and comments',
    levels: ['none', 'read', 'write', 'admin'],
    rules: {
      // Subscriptions.
      read: [{ action: 'read', subject: ['Post', 'Comment'] }],
      write: [
        { action: ['create', 'update'], subject: 'Post' },
        { action: 'create', subject: 'Comment' },
      ],
      admin: [{ action: 'delete', subject: 'Post' }],
    },
  },
  account: {
    description: 'The signed-in account (`me`)',
    levels: ['none', 'profile', 'full'],
    rules: {
      profile: [{ action: 'read', subject: 'Account', fields: ['id', 'name'] }],
      full: [{ action: 'read', subject: 'Account', fields: ['roles'] }],
    },
  },
});

export const caslOptions: CaslModuleOptions<CurrentUser> = {
  permissions,
  // What each user may do at most; the token's grant narrows it further.
  defineUserAbility(user, { can }) {
    can('read', ['Post', 'Comment']);
    can('create', ['Post', 'Comment']);
    can('update', 'Post', { authorId: user.id });
    can('read', 'Account', { id: user.id });
    if (user.roles.includes('admin')) can('manage', 'all');
  },
  // GraphQL is the only transport guarded by AbilityGuard here: the identity is the GraphQL
  // context's (from the bearer token, or the WebSocket's connectionParams).
  resolve(ctx) {
    const { currentUser, grant } = ctx as unknown as { currentUser?: CurrentUser; grant?: unknown };
    return currentUser && { user: currentUser, grant };
  },
};
