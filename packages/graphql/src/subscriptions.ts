import { BadRequestException, type Ctx, type WsEndpoint, type WsSocket } from '@knead-js/http';
import type { GraphQLRequest, LeavenExecutor, SubscriptionIterator } from '@leaven-graphql/core';
import {
  type WebSocketContext,
  WebSocketHandler,
  type WebSocketHandlerConfig,
} from '@leaven-graphql/ws';
import type { ServerWebSocket } from 'bun';
import {
  type ConnectionIdentity,
  type ConnectionPredicate,
  connectionInitTimeoutOf,
  DeferredRevocations,
  identityContext,
  resolveConnectionIdentity,
} from './connect.js';
import type { OperationContext } from './context.js';
import { toSafeError } from './errors.js';
import { queryTooLongMessage, type SubscriptionOptions } from './options.js';
import { leavenLogger } from './pubsub.js';
import type { GraphQLRuntime } from './runtime.js';

export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

/** Accepted subscribe/complete message ids. */
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

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
  /** The WsRegistry socket data, whose connection slot onConnect holds while it is pending. */
  slot: object;
  /** Computed once, at connection_init; undefined before, or when it was refused. */
  identity: ConnectionIdentity | undefined;
  /** Set when the socket closed; a subscribe that completes later is returned at once. */
  closed: boolean;
  pending: Set<PendingSubscribe>;
  /** The active iterator per subscription id. */
  iterators: Map<string, AsyncIterator<unknown>>;
  /** Set once onConnect has settled; until then revocations are deferred. */
  initDone: boolean;
  /** closeWhere predicates issued before init completed, re-applied when it does. */
  revocations: DeferredRevocations<SocketRevocation>;
}

/** A closeWhere kept for a socket: the close code and reason are the caller's. */
interface SocketRevocation {
  readonly predicate: ConnectionPredicate;
  readonly code: number;
  readonly reason: string;
}

/** The close of a socket that cannot keep another revocation (fail closed). */
const REVOCATION_UNAVAILABLE = [1008, 'Revocation state unavailable'] as const;

interface PeekedMessage {
  type?: unknown;
  id?: unknown;
  payload?: { query?: unknown } | null;
}

/**
 * Whether `text` may be a frame whose type is one the message handler checks before Leaven
 * (subscribe or complete). Without a backslash, a JSON string holds its
 * characters literally, so such a type must appear as is; any frame with an escape is parsed.
 */
const mayNeedPeek = (text: string): boolean =>
  text.includes('\\') || text.includes('subscribe') || text.includes('complete');

/** The message as JSON, or undefined when it is not a JSON object (Leaven then rejects it). */
function peek(text: string): PeekedMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
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

/**
 * A per-operation view of the shared upgrade Ctx: its own `state`, a shallow copy of the
 * upgrade's (so it sees what middleware and guards set at upgrade time, but its writes stay its
 * own); everything else (headers, ip, query, ...) is read from the upgrade Ctx, with methods
 * bound to it.
 */
export function operationView(http: Ctx): Ctx {
  const state: Ctx['state'] = { ...http.state };
  return new Proxy(http, {
    get(target, prop) {
      if (prop === 'state') return state;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const asLeavenSocket = (facade: SocketFacade) =>
  facade as unknown as ServerWebSocket<WebSocketContext>;

/** One open subscription socket, as `GraphQLSubscriptions.closeWhere` sees it. */
export interface GraphQLConnection {
  /** The upgrade request's Ctx. */
  readonly http: Ctx;
  /**
   * The connection's identity: the `context(http)` factory result (computed once, when the
   * connection initializes) with the object `onConnect` returned merged over it. Empty before
   * connection_init.
   */
  readonly context: Readonly<Record<PropertyKey, unknown>>;
}

export interface SubscriptionEndpoint extends WsEndpoint<UpgradeData> {
  /** The connection of a socket on this endpoint, or undefined for any other socket. */
  connection(ws: WsSocket): GraphQLConnection | undefined;
  /**
   * @internal Records a GraphQLSubscriptions.closeWhere predicate for a socket whose init has not
   * completed, to be re-applied to its connection once it has. Returns whether it was recorded.
   */
  deferRevocation(
    ws: WsSocket,
    predicate: (connection: GraphQLConnection) => boolean,
    code: number,
    reason: string,
  ): boolean;
  /** @internal Pending subscribes and tracked iterators of a socket (for tests). */
  stats(ws: WsSocket): { pending: number; iterators: number } | undefined;
}

function connectionOf(state: SocketState): GraphQLConnection {
  return { http: state.http, context: identityContext(state.identity) };
}

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

/** Marks `id`'s pending subscribes cancelled and forgets them. */
function dropPending(state: SocketState, id: string): void {
  for (const pending of state.pending) {
    if (pending.id !== id) continue;
    pending.cancelled = true;
    state.pending.delete(pending);
  }
}

/** The graphql-transport-ws endpoint registered with WsRegistry at the GraphQL path. */
export function createSubscriptionEndpoint(
  runtime: GraphQLRuntime,
  options: SubscriptionOptions,
  createHandler: HandlerFactory = leavenHandler,
): SubscriptionEndpoint {
  const facades = new WeakMap<WsSocket, SocketFacade>();
  const initTimeout = connectionInitTimeoutOf(runtime);
  /** Revocations recorded for sockets that had not opened yet, keyed by their socket data. */
  const early = new WeakMap<object, DeferredRevocations<SocketRevocation>>();
  const revocations = () =>
    new DeferredRevocations<SocketRevocation>(runtime.maxPendingRevocations);
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
  /** connection_init: the shared handshake, then the revocations kept meanwhile. */
  const initialize = async (
    socket: ServerWebSocket<WebSocketContext>,
    state: SocketState,
    params: Parameters<NonNullable<WebSocketHandlerConfig<OperationContext>['onConnect']>>[1],
  ): Promise<boolean> => {
    const identity = await resolveConnectionIdentity(runtime, {
      http: state.http,
      params: params ?? {},
      transport: 'WebSocket',
      // The socket closed while the factory ran (client gone, init timeout): no onConnect work.
      isGone: () => state.closed,
    });
    state.initDone = true;
    if (!identity) {
      state.revocations.clear();
      return false;
    }
    state.identity = identity;
    // A revocation issued while onConnect was pending must not miss this socket.
    const revoked = state.revocations.settle(connectionOf(state), runtime.masking);
    if (revoked) {
      (socket as unknown as SocketFacade).close(revoked.code, revoked.reason);
      return false;
    }
    return true;
  };
  const handler = createHandler({
    schema: runtime.schema,
    logger: leavenLogger(runtime.logger, runtime.development),
    connectionInitTimeout: initTimeout,
    keepAliveInterval: options.keepAliveInterval,
    subscriptionManager: {
      executor,
      maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection,
    },
    // Every way a subscribe ends reaches onComplete; a pending entry still there (Leaven gave up
    // before calling the executor, for example) is forgotten.
    onComplete: (socket, id) => {
      const state = states.get(socket);
      if (!state) return;
      for (const pending of state.pending) if (pending.id === id) state.pending.delete(pending);
    },
    onSubscribe: (socket, id, request) => {
      const pending: PendingSubscribe = { id, cancelled: false };
      stateOf(socket).pending.add(pending);
      requests.set(request, pending);
    },
    onConnect: async (socket, params) => {
      const state = stateOf(socket);
      if (state.closed) return false;
      // The socket's slot stays taken until the factory and onConnect settle, even if the client
      // closes meanwhile, so pending connection_init work is bounded by the connection limits.
      // Leaven bounds onConnect by connectionInitTimeout, closing the socket with 4408 and
      // ignoring a late result.
      const done = runtime.ws.holdSlot(state.slot);
      try {
        return await initialize(socket, state, params);
      } finally {
        done();
      }
    },
    context: async (socket, request) => {
      const state = stateOf(socket);
      const pending = requests.get(request);
      try {
        // Each operation gets its own view of the upgrade Ctx with a fresh `state`, so one
        // operation's ctx.http.state never leaks into the next.
        const op = await runtime.createOperationContext(
          operationView(state.http),
          ['subscription'],
          state.identity?.extra,
        );
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
      return state && connectionOf(state);
    },
    deferRevocation(ws, predicate, code, reason) {
      const facade = facades.get(ws);
      if (!facade) {
        // Still upgrading (WsRegistry re-applies closeWhere before open): keep the predicate for
        // the connection that open() creates, which fails closed if the list overflowed.
        if (ws.data.endpoint !== runtime.options.path) return false;
        let kept = early.get(ws.data);
        if (!kept) {
          kept = revocations();
          early.set(ws.data, kept);
        }
        kept.keep({ predicate, code, reason });
        return true;
      }
      const state = states.get(facade);
      if (!state || state.initDone || state.closed) return false;
      // Too many to keep: fail closed rather than let one escape.
      if (!state.revocations.keep({ predicate, code, reason })) ws.close(...REVOCATION_UNAVAILABLE);
      return true;
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
      // Without this header Bun echoes the first offered subprotocol, which may not be this one.
      ctx.res.headers.set('sec-websocket-protocol', GRAPHQL_TRANSPORT_WS);
      return { http: ctx };
    },
    open(ws) {
      const { http } = ws.data.data as UpgradeData;
      const facade: SocketFacade = {
        data: undefined as unknown as WebSocketContext,
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      };
      const kept = early.get(ws.data) ?? revocations();
      early.delete(ws.data);
      if (kept.overflowed) {
        ws.close(...REVOCATION_UNAVAILABLE);
        return;
      }
      facades.set(ws, facade);
      states.set(facade, {
        http,
        slot: ws.data,
        identity: undefined,
        closed: false,
        pending: new Set(),
        iterators: new Map(),
        initDone: false,
        revocations: kept,
      });
      handler.handleOpen(asLeavenSocket(facade));
    },
    async message(ws, message) {
      const facade = facades.get(ws);
      if (!facade) return;
      const state = stateOf(facade);
      // Leaven parses the frame again: skip the first parse for frames (connection_init, pings,
      // pongs) whose type cannot be one checked here. Leaven rejects a repeated connection_init
      // with 4429 itself, before awaiting onConnect.
      const text = typeof message === 'string' ? message : message.toString();
      const parsed = mayNeedPeek(text) ? peek(text) : undefined;
      // Ids end up in Leaven's logs and maps: anything but a short, plain id closes the socket
      // before the message reaches Leaven. Leaven validates ids too; this is a duplicate safety
      // net, with Leaven's close reason.
      if (
        (parsed?.type === 'subscribe' || parsed?.type === 'complete') &&
        (typeof parsed.id !== 'string' || !MESSAGE_ID.test(parsed.id))
      ) {
        ws.close(4400, 'Invalid message');
        return;
      }
      if (parsed?.type === 'complete' && typeof parsed.id === 'string') {
        dropPending(state, parsed.id);
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
        // Leaven answers a subscribe on an uninitialized socket with 4401; so does an
        // over-long one, rather than an error frame the protocol does not allow before init.
        if (!(facade.data as WebSocketContext | undefined)?.initialized) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        // Reusing an active id closes the socket, as Leaven does for a subscribe of any length.
        if ((facade.data as WebSocketContext).subscriptions?.has(parsed.id)) {
          ws.close(4409, `Subscriber for ${parsed.id} already exists`);
          return;
        }
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
      await handler.handleMessage(asLeavenSocket(facade), text);
    },
    async close(ws) {
      const facade = facades.get(ws);
      if (!facade) return;
      facades.delete(ws);
      const state = stateOf(facade);
      state.closed = true;
      for (const iterator of state.iterators.values()) discard(iterator);
      state.iterators.clear();
      state.pending.clear();
      state.revocations.clear();
      await handler.handleClose(asLeavenSocket(facade));
    },
  };
}
