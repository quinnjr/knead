import { inject } from '@knead-js/core';
import { GraphQLSubscriptions } from '@knead-js/graphql';
import { type Member, SessionService } from './sessions.js';

// #region close-where
export class SignOutService {
  readonly #sessions = inject(SessionService);
  readonly #subscriptions = inject(GraphQLSubscriptions);

  /** Ends the token and every subscription socket opened with it; returns how many closed. */
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
