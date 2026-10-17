import type { AbilityBuilder, Identity, MongoAbility } from '@knead-js/casl';

// #region user
export interface User {
  id: string;
  name: string;
  admin: boolean;
}

/** The most this user may ever do; the credential's grant narrows it. */
export function defineUserAbility(user: User, { can }: AbilityBuilder<MongoAbility>): void {
  can('read', 'Post');
  can(['create', 'update'], 'Post', { authorId: user.id });
  can('read', 'User', ['id', 'name']);
  can('read', 'User', { id: user.id });
  if (user.admin) can('manage', 'all');
}
// #endregion user

// #region sessions
/** Your token store: each access token maps to its user and the grant it was issued with. */
export const sessions = new Map<string, Identity<User>>();

export function sessionFrom(req: Request): Identity<User> | undefined {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  return sessions.get(header.slice('Bearer '.length));
}
// #endregion sessions
