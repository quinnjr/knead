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
   * The predicate sees `connection.context`, the merged identity: the `context(http)` factory
   * result with the `onConnect` result over it. Logs at debug level when nothing matched.
   * Sockets whose `onConnect` has not completed (or that have not sent connection_init yet) are
   * checked again once it completes, and closed then if they match. A predicate that throws for
   * a socket is logged and that socket is skipped.
   */
  closeWhere(
    predicate: (connection: GraphQLConnection) => boolean,
    code = 1008,
    reason = 'Connection revoked',
  ): number {
    const count = this.#ws.closeWhere(
      (ws) => {
        const connection = this.#runtime.connection(ws);
        if (connection === undefined) {
          // Not opened yet (WsRegistry applies this before open): checked once its init completes.
          this.#runtime.deferRevocation(ws, predicate, code, reason);
          return false;
        }
        // A socket still in connection_init/onConnect has no context yet: the predicate is
        // applied again when its init completes, so it cannot escape the revocation.
        this.#runtime.deferRevocation(ws, predicate, code, reason);
        return predicate(connection);
      },
      code,
      reason,
    );
    if (count === 0) {
      this.#runtime.logger.debug(
        'GraphQLSubscriptions.closeWhere matched no open sockets (sockets still initializing are checked when they finish).',
      );
    }
    return count;
  }
}
