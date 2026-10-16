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

const ROLES = Symbol('roles');
const rolesMeta = createRouteDecorator<readonly string[]>(ROLES);

/** Role metadata read by RolesGuard through `ctx.meta`. */
export const Roles = (...roles: string[]) => rolesMeta(roles);

/** Resolver guard: `false` (FORBIDDEN) unless the user has one of the @Roles() roles. */
export function RolesGuard(ctx: ResolverCtx): boolean {
  const required = ctx.meta[ROLES] as readonly string[] | undefined;
  if (!required?.length) return true;
  return required.some((role) => ctx.currentUser?.roles.includes(role));
}

@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
