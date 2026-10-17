import { type AbilityCtx, type CaslModuleOptions, definePermissions } from '@knead-js/casl';
import type { Ctx } from '@knead-js/http';
import type { User } from './auth.js';

/** What a token may be granted, area by area; `none` (the first level) is no access. */
export const permissions = definePermissions({
  users: {
    description: 'User accounts',
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'User' }],
      write: [{ action: ['create', 'delete'], subject: 'User' }],
    },
  },
});

export const caslOptions: CaslModuleOptions<User> = {
  permissions,
  // What each user may do at most; a token's grant narrows it further.
  defineUserAbility(user, { can }) {
    can('read', 'User');
    if (user.roles.includes('admin')) can('manage', 'all');
  },
  // REST routes run AuthGuard first, which stores the session on ctx.state; GraphQL resolvers
  // read it from the GraphQL context.
  resolve: (ctx: AbilityCtx) =>
    'info' in ctx ? (ctx as unknown as { session?: Session }).session : (ctx as Ctx).state.session,
};

export interface Session {
  user: User;
  /** The token's grant (`area:level` scopes or an `{ area: level }` object). */
  grant: unknown;
}
