import { inject, Module } from '@hpmws/core';
import { type Ctx, createRouteDecorator, type Guard, UnauthorizedException } from '@hpmws/http';

export interface User {
  id: string;
  name: string;
  roles: string[];
}

declare module '@hpmws/http' {
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

export class RolesGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    const required = ctx.route?.meta.roles as string[] | undefined;
    if (!required?.length) return true;
    return required.some((role) => ctx.state.user?.roles.includes(role));
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
