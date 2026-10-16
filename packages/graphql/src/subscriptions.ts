import { BadRequestException, type Ctx, type WsEndpoint, type WsSocket } from '@hpmws/http';
import { type WebSocketContext, WebSocketHandler } from '@leaven-graphql/ws';
import type { ServerWebSocket } from 'bun';
import type { OperationContext } from './context.js';
import { toSafeError } from './errors.js';
import { queryTooLongMessage, type SubscriptionOptions } from './options.js';
import type { GraphQLRuntime } from './runtime.js';

export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

interface UpgradeData {
  http: Ctx;
}

/**
 * What Leaven's WebSocketHandler sees instead of the real socket. Leaven overwrites
 * `socket.data` in handleOpen, which would clobber WsRegistry's `{ endpoint, data }` routing.
 */
interface SocketFacade {
  data: WebSocketContext;
  send(message: string): number;
  close(code?: number, reason?: string): void;
}

interface SocketState {
  http: Ctx;
  extra: object | undefined;
}

interface PeekedMessage {
  type?: unknown;
  id?: unknown;
  payload?: { query?: unknown } | null;
}

/** The message as JSON, or undefined when it is not a JSON object (Leaven then rejects it). */
function peek(message: string | Buffer): PeekedMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(typeof message === 'string' ? message : message.toString());
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PeekedMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

const asLeavenSocket = (facade: SocketFacade) =>
  facade as unknown as ServerWebSocket<WebSocketContext>;

/** The graphql-transport-ws endpoint registered with WsRegistry at the GraphQL path. */
export function createSubscriptionEndpoint(
  runtime: GraphQLRuntime,
  options: SubscriptionOptions,
): WsEndpoint<UpgradeData> {
  const facades = new WeakMap<WsSocket, SocketFacade>();
  const states = new WeakMap<object, SocketState>();
  const stateOf = (socket: object): SocketState => {
    const state = states.get(socket);
    if (!state) throw new Error('Unknown GraphQL WebSocket');
    return state;
  };
  const handler = new WebSocketHandler<OperationContext>({
    schema: runtime.schema,
    connectionInitTimeout: options.connectionInitTimeout,
    keepAliveInterval: options.keepAliveInterval,
    subscriptionManager: {
      executor: runtime.executor,
      maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection,
    },
    onConnect: async (socket, params) => {
      if (!options.onConnect) return true;
      const state = stateOf(socket);
      try {
        const result = await options.onConnect(state.http, params ?? {});
        if (result === false) return false;
        if (typeof result === 'object' && result !== null) state.extra = result;
        return true;
      } catch (error) {
        runtime.logger.error(
          'GraphQL subscriptions onConnect threw; rejecting the connection',
          error,
        );
        return false;
      }
    },
    context: async (socket, request) => {
      const state = stateOf(socket);
      try {
        const op = await runtime.createOperationContext(state.http, ['subscription'], state.extra);
        op.operationName = request.operationName;
        return op;
      } catch (error) {
        // Leaven sends a thrown error's message to the client verbatim.
        throw toSafeError(error, runtime.masking, 'the subscription context factory');
      }
    },
  });
  return {
    upgrade(ctx) {
      const offered = (ctx.req.headers.get('sec-websocket-protocol') ?? '')
        .split(',')
        .map((p) => p.trim());
      // WsRegistry has already checked Origin (same origin or subscriptions.allowedOrigins).
      if (!offered.includes(GRAPHQL_TRANSPORT_WS)) {
        throw new BadRequestException(
          `GraphQL subscriptions require the ${GRAPHQL_TRANSPORT_WS} WebSocket subprotocol.`,
        );
      }
      return { http: ctx };
    },
    open(ws) {
      const { http } = ws.data.data as UpgradeData;
      const facade: SocketFacade = {
        data: undefined as unknown as WebSocketContext,
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      };
      facades.set(ws, facade);
      states.set(facade, { http, extra: undefined });
      handler.handleOpen(asLeavenSocket(facade));
    },
    async message(ws, message) {
      const facade = facades.get(ws);
      if (!facade) return;
      const parsed = peek(message);
      const max = runtime.options.maxQueryLength;
      if (
        parsed?.type === 'subscribe' &&
        typeof parsed.id === 'string' &&
        max !== false &&
        typeof parsed.payload?.query === 'string' &&
        parsed.payload.query.length > max
      ) {
        ws.send(
          JSON.stringify({
            id: parsed.id,
            type: 'error',
            payload: [
              { message: queryTooLongMessage(max), extensions: { code: 'BAD_USER_INPUT' } },
            ],
          }),
        );
        return;
      }
      await handler.handleMessage(asLeavenSocket(facade), message);
    },
    async close(ws) {
      const facade = facades.get(ws);
      if (!facade) return;
      facades.delete(ws);
      await handler.handleClose(asLeavenSocket(facade));
    },
  };
}
