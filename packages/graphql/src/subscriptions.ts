import { BadRequestException, type Ctx, type WsEndpoint, type WsSocket } from '@hpmws/http';
import type { GraphQLRequest, LeavenExecutor, SubscriptionIterator } from '@leaven-graphql/core';
import {
  type WebSocketContext,
  WebSocketHandler,
  type WebSocketHandlerConfig,
} from '@leaven-graphql/ws';
import type { ServerWebSocket } from 'bun';
import type { OperationContext } from './context.js';
import { logInternalError, toSafeError } from './errors.js';
import { queryTooLongMessage, type SubscriptionOptions } from './options.js';
import { leavenLogger } from './pubsub.js';
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

/** A subscribe message between Leaven's onSubscribe and the executor's result. */
interface PendingSubscribe {
  readonly id: string;
  cancelled: boolean;
}

interface SocketState {
  http: Ctx;
  extra: object | undefined;
  /** Set synchronously on the first connection_init, before Leaven awaits onConnect. */
  initStarted: boolean;
  /** Set when the socket closed; a subscribe that completes later is returned at once. */
  closed: boolean;
  pending: Set<PendingSubscribe>;
  /** The active iterator per subscription id. */
  iterators: Map<string, AsyncIterator<unknown>>;
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

const isIterator = <T>(value: object): value is SubscriptionIterator<T> =>
  Symbol.asyncIterator in value;

/** Calls `return()` and ignores its failure (the iterator is being discarded). */
function discard(iterator: AsyncIterator<unknown>): void {
  void iterator.return?.()?.catch?.(() => {});
}

/**
 * Wraps `iterator` so it leaves `state.iterators` once it finishes or is returned, and returns
 * whatever iterator was registered under the same id before it.
 */
function track<T>(
  state: SocketState,
  id: string,
  iterator: SubscriptionIterator<T>,
): SubscriptionIterator<T> {
  const forget = () => {
    if (state.iterators.get(id) === tracked) state.iterators.delete(id);
  };
  const tracked: SubscriptionIterator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      const result = await iterator.next();
      if (result.done) forget();
      return result;
    },
    async return() {
      forget();
      await iterator.return?.();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      forget();
      if (iterator.throw) return iterator.throw(error);
      throw error;
    },
  };
  const previous = state.iterators.get(id);
  if (previous) discard(previous);
  state.iterators.set(id, tracked);
  return tracked;
}

const asLeavenSocket = (facade: SocketFacade) =>
  facade as unknown as ServerWebSocket<WebSocketContext>;

/** One open subscription socket, as `GraphQLSubscriptions.closeWhere` sees it. */
export interface GraphQLConnection {
  /** The upgrade request's Ctx. */
  readonly http: Ctx;
  /** The object `onConnect` returned (empty before connection_init, or without onConnect). */
  readonly context: Readonly<Record<PropertyKey, unknown>>;
}

export interface SubscriptionEndpoint extends WsEndpoint<UpgradeData> {
  /** The connection of a socket on this endpoint, or undefined for any other socket. */
  connection(ws: WsSocket): GraphQLConnection | undefined;
  /** @internal Pending subscribes and tracked iterators of a socket (for tests). */
  stats(ws: WsSocket): { pending: number; iterators: number } | undefined;
}

const EMPTY_CONTEXT: Readonly<Record<PropertyKey, unknown>> = Object.freeze({});

/** The parts of Leaven's WebSocketHandler the endpoint drives. */
export type LeavenSocketHandler = Pick<
  WebSocketHandler<OperationContext>,
  'handleOpen' | 'handleMessage' | 'handleClose'
>;

/** Builds Leaven's handler; a parameter so tests can drive the endpoint without Leaven. */
export type HandlerFactory = (
  config: WebSocketHandlerConfig<OperationContext>,
) => LeavenSocketHandler;

const leavenHandler: HandlerFactory = (config) => new WebSocketHandler<OperationContext>(config);

/** The graphql-transport-ws endpoint registered with WsRegistry at the GraphQL path. */
export function createSubscriptionEndpoint(
  runtime: GraphQLRuntime,
  options: SubscriptionOptions,
  createHandler: HandlerFactory = leavenHandler,
): SubscriptionEndpoint {
  const facades = new WeakMap<WsSocket, SocketFacade>();
  const states = new WeakMap<object, SocketState>();
  const stateOf = (socket: object): SocketState => {
    const state = states.get(socket);
    if (!state) throw new Error('Unknown GraphQL WebSocket');
    return state;
  };
  const requests = new WeakMap<GraphQLRequest, PendingSubscribe>();
  const operations = new WeakMap<object, { state: SocketState; pending: PendingSubscribe }>();
  const settle = (context: unknown) => {
    const entry = typeof context === 'object' && context !== null && operations.get(context);
    if (entry) entry.state.pending.delete(entry.pending);
    return entry || undefined;
  };
  // Leaven's subscription manager accepts only a LeavenExecutor, so this one inherits from the
  // runtime's and only intercepts results: a subscription that resolves after its socket closed
  // (or after the client completed it) is returned at once, and every other one is tracked so
  // close() and a reused id can return it.
  const real = runtime.executor;
  const executor = Object.create(real) as LeavenExecutor;
  Object.assign(executor, {
    execute: (request: GraphQLRequest, context: unknown) => {
      settle(context);
      return real.execute(request, context);
    },
    subscribe: async (request: GraphQLRequest, context: unknown) => {
      const result = await real.subscribe(request, context);
      const entry = settle(context);
      if (!entry || !isIterator(result)) return result;
      if (entry.state.closed || entry.pending.cancelled) {
        await result.return?.();
        return result;
      }
      return track(entry.state, entry.pending.id, result);
    },
  });
  const handler = createHandler({
    schema: runtime.schema,
    logger: leavenLogger(runtime.logger),
    connectionInitTimeout: options.connectionInitTimeout,
    keepAliveInterval: options.keepAliveInterval,
    subscriptionManager: {
      executor,
      maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection,
    },
    onSubscribe: (socket, id, request) => {
      const pending: PendingSubscribe = { id, cancelled: false };
      stateOf(socket).pending.add(pending);
      requests.set(request, pending);
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
        logInternalError(
          runtime.masking,
          'GraphQL subscriptions onConnect threw; rejecting the connection',
          error,
        );
        return false;
      }
    },
    context: async (socket, request) => {
      const state = stateOf(socket);
      const pending = requests.get(request);
      try {
        const op = await runtime.createOperationContext(state.http, ['subscription'], state.extra);
        op.operationName = request.operationName;
        if (pending) operations.set(op, { state, pending });
        return op;
      } catch (error) {
        if (pending) state.pending.delete(pending);
        // Leaven sends a thrown error's message to the client verbatim.
        throw toSafeError(error, runtime.masking, 'the subscription context factory');
      }
    },
  });
  return {
    stats(ws) {
      const facade = facades.get(ws);
      const state = facade && states.get(facade);
      return state && { pending: state.pending.size, iterators: state.iterators.size };
    },
    connection(ws) {
      const facade = facades.get(ws);
      const state = facade && states.get(facade);
      if (!state) return undefined;
      return {
        http: state.http,
        context: state.extra ? Object.freeze({ ...state.extra }) : EMPTY_CONTEXT,
      };
    },
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
      states.set(facade, {
        http,
        extra: undefined,
        initStarted: false,
        closed: false,
        pending: new Set(),
        iterators: new Map(),
      });
      handler.handleOpen(asLeavenSocket(facade));
    },
    async message(ws, message) {
      const facade = facades.get(ws);
      if (!facade) return;
      const state = stateOf(facade);
      const parsed = peek(message);
      if (parsed?.type === 'connection_init') {
        // Leaven marks the socket initialized only after awaiting onConnect, so two quick
        // connection_init messages would both be acknowledged.
        if (state.initStarted) {
          ws.close(4429, 'Too many initialisation requests');
          return;
        }
        state.initStarted = true;
      }
      if (parsed?.type === 'complete' && typeof parsed.id === 'string') {
        for (const pending of state.pending) if (pending.id === parsed.id) pending.cancelled = true;
        const iterator = state.iterators.get(parsed.id);
        if (iterator) discard(iterator);
      }
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
      const state = stateOf(facade);
      state.closed = true;
      for (const iterator of state.iterators.values()) discard(iterator);
      state.iterators.clear();
      await handler.handleClose(asLeavenSocket(facade));
    },
  };
}
