import { Module } from '@hpmws/core';
import type { ResolverCtx } from '@hpmws/graphql';
import { createRouteDecorator, UnauthorizedException } from '@hpmws/http';

/** The signed-in user. Each user is also an author of the blog (same id). */
export interface CurrentUser {
  id: string;
  name: string;
  roles: string[];
}

declare module '@hpmws/graphql' {
  interface GraphQLContext {
    currentUser?: CurrentUser;
  }
}

/**
 * Demo-only token store. The bearer tokens below are hard-coded and public: anyone who reads this
 * file can sign in as an admin. Use real authentication (signed, expiring tokens from an identity
 * provider) in a real application.
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

  readonly #tokens = new Map<string, CurrentUser>([
    ['ada-token', { id: 'a1', name: 'Ada Lovelace', roles: ['admin'] }],
    ['grace-token', { id: 'a2', name: 'Grace Hopper', roles: [] }],
  ]);

  verify(token: unknown): CurrentUser | undefined {
    return typeof token === 'string' ? this.#tokens.get(token) : undefined;
  }

  /** The user named by an `Authorization: Bearer <token>` header, if any. */
  fromAuthorization(header: string | null | undefined): CurrentUser | undefined {
    return header?.startsWith('Bearer ') ? this.verify(header.slice(7)) : undefined;
  }
}

/** Resolver guard: no signed-in user is UNAUTHENTICATED. */
export function Authenticated(ctx: ResolverCtx): boolean {
  if (!ctx.currentUser) throw new UnauthorizedException('Sign in with a bearer token.');
  return true;
}

/** The `ctx.meta` key @Roles() writes. */
export const ROLES = Symbol('roles');
const rolesMeta = createRouteDecorator<readonly string[]>(ROLES);

/** Role metadata read by RolesGuard through `ctx.meta`. */
export const Roles = (...roles: string[]) => rolesMeta(roles);

/**
 * Resolver guard reading @Roles() through `ctx.meta`: `true` only when a signed-in user holds one
 * of the required roles. Everything else is `false` (FORBIDDEN), including a resolver that uses
 * the guard without @Roles(): a missing annotation fails closed.
 */
export function RolesGuard(ctx: ResolverCtx): boolean {
  const required = ctx.meta[ROLES];
  const user = ctx.currentUser;
  if (!Array.isArray(required) || required.length === 0 || !user) return false;
  return required.some((role) => user.roles.includes(role));
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
