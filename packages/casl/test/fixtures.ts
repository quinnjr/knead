import type { AbilityBuilder, MongoAbility } from '@casl/ability';
import type { Ctx } from '@knead-js/http';
import { type AbilityCtx, type CaslModuleOptions, definePermissions } from '../src/index.js';

export interface TestUser {
  id: string;
  roles: string[];
}

export const permissions = definePermissions({
  posts: {
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: 'update', subject: 'Post' }],
    },
  },
  billing: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }] },
  },
});

export function defineUserAbility(user: TestUser, { can }: AbilityBuilder<MongoAbility>): void {
  can('read', 'Post');
  can('update', 'Post', { authorId: user.id });
  if (user.roles.includes('admin')) can('manage', 'all');
}

/** `authorization: Bearer <user>|<grantJSON>`; user `admin` has the admin role. */
export function resolve(ctx: AbilityCtx) {
  const header = (ctx as Ctx).req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  const raw = header.slice(7);
  const i = raw.indexOf('|');
  const id = i === -1 ? raw : raw.slice(0, i);
  const grant: unknown = i === -1 ? undefined : JSON.parse(raw.slice(i + 1));
  return { user: { id, roles: id === 'admin' ? ['admin'] : [] }, grant };
}

export const options: CaslModuleOptions<TestUser> = { permissions, resolve, defineUserAbility };

export const bearer = (user: string, grant: unknown) => ({
  headers: { authorization: `Bearer ${user}|${JSON.stringify(grant)}` },
});
