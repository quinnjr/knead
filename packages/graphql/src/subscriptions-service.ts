import { inject } from '@hpmws/core';
import { WsRegistry } from '@hpmws/http';
import { GraphQLRuntime } from './runtime.js';
import type { GraphQLConnection } from './subscriptions.js';

/**
 * Revokes subscription sockets, for example when a user signs out or loses a role:
 * `inject(GraphQLSubscriptions).closeWhere((c) => c.context.user?.id === id)`.
 */
export class GraphQLSubscriptions {
  readonly #runtime = inject(GraphQLRuntime);
  readonly #ws = inject(WsRegistry);

  /**
   * Closes every GraphQL subscription socket whose connection matches `predicate` (default code
   * 1008, reason "Connection revoked"), ending its subscriptions, and returns how many closed.
   */
  closeWhere(
    predicate: (connection: GraphQLConnection) => boolean,
    code = 1008,
    reason = 'Connection revoked',
  ): number {
    return this.#ws.closeWhere(
      (ws) => {
        const connection = this.#runtime.connection(ws);
        return connection !== undefined && predicate(connection);
      },
      code,
      reason,
    );
  }
}
