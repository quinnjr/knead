import { fullGrant } from '@knead-js/casl';
import { Injectable, Module } from '@knead-js/core';
import { permissions } from './permissions.js';

/** The signed-in user. Each user is also an author of the blog (same id). */
export interface CurrentUser {
  id: string;
  name: string;
  roles: string[];
}

/** A verified token: who it belongs to and what it was granted. */
export interface Session {
  user: CurrentUser;
  /** `area:level` scopes, as a personal access token would carry them. */
  grant: unknown;
}

declare module '@knead-js/graphql' {
  interface GraphQLContext {
    currentUser?: CurrentUser;
    /** The token's grant, read by CaslModule (see permissions.ts). */
    grant?: unknown;
    /** Subscriptions: the connection's token, re-verified by subscriptions.refreshContext. */
    sessionToken?: string;
  }
}

const ADA: CurrentUser = { id: 'a1', name: 'Ada Lovelace', roles: ['admin'] };
const GRACE: CurrentUser = { id: 'a2', name: 'Grace Hopper', roles: [] };

/** The GraphQL context entries for a session (none for an anonymous request). */
export function sessionContext(session: Session | undefined) {
  return { currentUser: session?.user, grant: session?.grant };
}

/**
 * Demo-only token store. The bearer tokens below are hard-coded and public: anyone who reads this
 * file can sign in as an admin. Use real authentication (signed, expiring tokens from an identity
 * provider) in a real application.
 *
 * Each token carries a grant. A real token issuer checks the requested grant with
 * `AbilityService.validateGrant()` before issuing it.
 */
@Injectable()
export class AuthService {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'The demo AuthService accepts hard-coded, public demo tokens and refuses to start with ' +
          'NODE_ENV=production. Replace it with real authentication before deploying.',
      );
    }
  }

  readonly #tokens = new Map<string, Session>([
    // A first-party session: everything Ada can do.
    ['ada-token', { user: ADA, grant: fullGrant(permissions) }],
    ['grace-token', { user: GRACE, grant: 'blog:write account:profile' }],
    // A read-only token: Grace may write, but this token may not.
    ['grace-reader-token', { user: GRACE, grant: 'blog:read account:profile' }],
  ]);

  /** Signs a token out: it stops verifying at once (live subscriptions end at their next event). */
  revoke(token: string): boolean {
    return this.#tokens.delete(token);
  }

  verify(token: unknown): Session | undefined {
    return typeof token === 'string' ? this.#tokens.get(token) : undefined;
  }

  /** The session named by an `Authorization: Bearer <token>` header, if any. */
  fromAuthorization(header: string | null | undefined): Session | undefined {
    return header?.startsWith('Bearer ') ? this.verify(header.slice(7)) : undefined;
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
