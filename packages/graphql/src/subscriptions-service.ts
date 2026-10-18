import { Injectable, inject } from '@knead-js/core';
import { WsRegistry } from '@knead-js/http';
import { GraphQLRuntime } from './runtime.js';
import type { GraphQLConnection } from './subscriptions.js';

/**
 * Revokes subscription sockets and SSE subscription streams, for example when a user signs out
 * or loses a role:
 * `inject(GraphQLSubscriptions).closeWhere((c) => c.context.user?.id === id)`.
 */
@Injectable()
export class GraphQLSubscriptions {
  readonly #runtime = inject(GraphQLRuntime);
  readonly #ws = inject(WsRegistry);

  /**
   * Closes every GraphQL subscription socket whose connection matches `predicate` (default code
   * 1008, reason "Connection revoked"), ending its subscriptions, and ends every matching SSE
   * subscription stream (without `complete`); returns how many sockets and streams it ended.
   * The predicate sees `connection.context`, the merged identity: the `context(http)` factory
   * result with the `onConnect` result over it. Logs at debug level when nothing matched.
   * Sockets and streams whose `onConnect` has not completed (or sockets that have not sent
   * connection_init yet) are checked again once it completes, and refused then if they match (an
   * SSE stream answers 403). A predicate that throws for a socket or stream is logged and that
   * one is skipped.
   */
  closeWhere(
    predicate: (connection: GraphQLConnection) => boolean,
    code = 1008,
    reason = 'Connection revoked',
  ): number {
    const sockets = this.#ws.closeWhere(
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
    const count = sockets + this.#runtime.sse.closeWhere(predicate);
    if (count === 0) {
      this.#runtime.logger.debug(
        'GraphQLSubscriptions.closeWhere matched no open sockets or SSE streams (those still initializing are checked when they finish).',
      );
    }
    return count;
  }
}
