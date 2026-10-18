import { Injectable, Module } from '@knead-js/core';

// #region context-type
declare module '@knead-js/graphql' {
  interface GraphQLContext {
    /** The signed-in member, if any. */
    member?: Member;
  }
}
// #endregion context-type

export interface Member {
  id: string;
  name: string;
  roles: string[];
}

/**
 * Demo token store. The tokens are hard-coded and public; use real, expiring tokens from an
 * identity provider in an application.
 */
@Injectable()
export class SessionService {
  readonly #tokens = new Map<string, Member>([
    ['ada-token', { id: 'a1', name: 'Ada Lovelace', roles: ['admin'] }],
    ['grace-token', { id: 'a2', name: 'Grace Hopper', roles: [] }],
  ]);

  verify(token: unknown): Member | undefined {
    return typeof token === 'string' ? this.#tokens.get(token) : undefined;
  }

  /** The member named by an `Authorization: Bearer <token>` header. */
  fromAuthorization(header: string | null): Member | undefined {
    return header?.startsWith('Bearer ') ? this.verify(header.slice(7)) : undefined;
  }

  revoke(token: string): boolean {
    return this.#tokens.delete(token);
  }
}

@Module({ providers: [SessionService], exports: [SessionService] })
export class SessionModule {}
