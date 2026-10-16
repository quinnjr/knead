import { inject, Module } from '@knead/core';
import { type Ctx, createRouteDecorator, type Guard, UnauthorizedException } from '@knead/http';

export interface User {
  id: string;
  name: string;
  roles: string[];
}

declare module '@knead/http' {
  interface CtxState {
    user?: User;
  }
}

/**
 * Demo-only token store. The bearer tokens below are hard-coded and public:
 * anyone who reads this file can authenticate as an admin. Never ship this to
 * production; use real authentication instead (for example signed and expiring
 * JWTs or opaque session tokens issued by an identity provider, with tokens
 * stored hashed and revocable).
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

  readonly #tokens = new Map<string, User>([
    ['admin-token', { id: 'u1', name: 'Admin', roles: ['admin'] }],
    ['user-token', { id: 'u2', name: 'Regular', roles: [] }],
  ]);

  verify(token: string): User | undefined {
    // The token is looked up via Map rather than compared with ===.
    return this.#tokens.get(token);
  }
}

export class AuthGuard implements Guard {
  readonly #auth = inject(AuthService);

  canActivate(ctx: Ctx): boolean {
    const header = ctx.req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = token ? this.#auth.verify(token) : undefined;
    if (!user) throw new UnauthorizedException('Missing or invalid bearer token');
    ctx.state.user = user;
    return true;
  }
}

export const Roles = createRouteDecorator<string[]>('roles');

/**
 * Reads @Roles() through `ctx.meta` and passes only an authenticated user holding one of them.
 * Everything else is a 403, including a route that uses the guard without @Roles(): a missing
 * annotation fails closed.
 */
export class RolesGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    const required = ctx.meta.roles;
    const user = ctx.state.user;
    if (!Array.isArray(required) || required.length === 0 || !user) return false;
    return required.some((role) => user.roles.includes(role));
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
