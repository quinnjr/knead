import { fullGrant } from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { type Ctx, type Guard, UnauthorizedException } from '@knead-js/http';
import { permissions, type Session } from './permissions.js';

export interface User {
  id: string;
  name: string;
  roles: string[];
}

declare module '@knead-js/http' {
  interface CtxState {
    session?: Session;
  }
}

/**
 * Demo-only token store. The bearer tokens below are hard-coded and public:
 * anyone who reads this file can authenticate as an admin. Never ship this to
 * production; use real authentication instead (for example signed and expiring
 * JWTs or opaque session tokens issued by an identity provider, with tokens
 * stored hashed and revocable).
 *
 * Each token carries a grant, as a personal access token would. A real token issuer checks the
 * requested grant with `AbilityService.validateGrant()` before issuing it.
 */
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
    // A first-party session: everything the admin can do.
    [
      'admin-token',
      { user: { id: 'u1', name: 'Admin', roles: ['admin'] }, grant: fullGrant(permissions) },
    ],
    ['user-token', { user: { id: 'u2', name: 'Regular', roles: [] }, grant: 'users:read' }],
    // An admin's read-only token: the grant narrows what the admin could otherwise do.
    ['reader-token', { user: { id: 'u1', name: 'Admin', roles: ['admin'] }, grant: 'users:read' }],
  ]);

  verify(token: string): Session | undefined {
    // The token is looked up via Map rather than compared with ===.
    return this.#tokens.get(token);
  }
}

/** Authenticates the bearer token (401 otherwise) and stores its session for AbilityGuard. */
export class AuthGuard implements Guard {
  readonly #auth = inject(AuthService);

  canActivate(ctx: Ctx): boolean {
    const header = ctx.req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const session = token ? this.#auth.verify(token) : undefined;
    if (!session) throw new UnauthorizedException('Missing or invalid bearer token');
    ctx.state.session = session;
    return true;
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
