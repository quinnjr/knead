import { Injectable, inject } from '@knead-js/core';
import { GraphQLSubscriptions } from '@knead-js/graphql';
import { type Member, SessionService } from './sessions.js';

// #region close-where
@Injectable()
export class SignOutService {
  readonly #sessions = inject(SessionService);
  readonly #subscriptions = inject(GraphQLSubscriptions);

  /** Ends the token and the subscription sockets and SSE streams opened with it; returns how many. */
  signOut(token: string, memberId: string): number {
    this.#sessions.revoke(token);
    return this.#subscriptions.closeWhere(({ context }) => {
      // The connection context is the context factory result with the onConnect result over it.
      const member = context.member as Member | undefined;
      return member?.id === memberId;
    });
  }
}
// #endregion close-where
