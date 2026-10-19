import {
  BadRequestException,
  type Ctx,
  ForbiddenException,
  MethodNotAllowedException,
  originAllowed,
  ServiceUnavailableException,
} from '@knead-js/http';
import type { GraphQLRequest, GraphQLResponse } from '@leaven-graphql/core';
import { createEventStreamResponse, isSubscriptionIterator } from '@leaven-graphql/sse';
import { getOperationAST } from 'graphql';
import type { OperationContext, OperationKind } from './context.js';
import { type ErrorMaskingOptions, logInternalError, toSafeError } from './errors.js';
import { type ConnectionParams, DEFAULT_CONNECTION_INIT_TIMEOUT } from './options.js';
import {
  acceptQuality,
  GRAPHQL_RESPONSE_JSON,
  jsonHeaders,
  noDataStatus,
  rejectionMessage,
} from './responses.js';
import type { GraphQLRuntime } from './runtime.js';
import type { GraphQLConnection } from './subscriptions.js';

/**
 * True when `accept` prefers `text/event-stream` (named explicitly) strictly over
 * `application/json` and `application/graphql-response+json`: on a tie, or for wildcards alone,
 * the response stays JSON.
 */
export function wantsEventStream(accept: string | null): boolean {
  const sse = acceptQuality(accept, 'text/event-stream', true);
  const json = Math.max(
    acceptQuality(accept, 'application/json'),
    acceptQuality(accept, GRAPHQL_RESPONSE_JSON),
  );
  return sse > 0 && sse > json;
}

/** One open SSE subscription stream, as revocation sees it. */
export interface SseConnection {
  /** The subscription request's Ctx. */
  readonly http: Ctx;
  /**
   * The `context(http)` factory result with the object `onConnect` returned merged over it.
   * Empty until `onConnect` has settled.
   */
  context: Readonly<Record<PropertyKey, unknown>>;
  /** Ends the stream without `complete`: returns the iterator and closes the response body. */
  end(): void;
  /** Whether `onConnect` has settled (the connection is registered, with its slot, before). */
  initDone: boolean;
}

type ConnectionPredicate = (connection: GraphQLConnection) => boolean;

/** What SseConnections reads from its GraphQLRuntime. */
interface SseConnectionsHost {
  readonly masking: ErrorMaskingOptions;
  /** `listen({ websocket: { maxPendingRevocations } })`: the predicates kept per pending stream. */
  readonly maxPendingRevocations: number;
}

/**
 * The open SSE subscription streams of a GraphQLRuntime, for GraphQLSubscriptions.closeWhere.
 * Shutdown ends them through StreamRegistry.endStreams(), which holds their slots.
 */
export class SseConnections {
  readonly #host: SseConnectionsHost;
  readonly #open = new Set<SseConnection>();
  /** closeWhere predicates kept for streams whose onConnect has not settled. */
  readonly #deferred = new Map<SseConnection, ConnectionPredicate[]>();

  constructor(host: SseConnectionsHost) {
    this.#host = host;
  }

  add(connection: SseConnection): void {
    this.#open.add(connection);
  }

  delete(connection: SseConnection): void {
    this.#open.delete(connection);
    this.#deferred.delete(connection);
  }

  /**
   * Ends (without `complete`) every open stream whose connection matches `predicate` and returns
   * how many. A stream whose onConnect has not settled also keeps the predicate, which settle()
   * applies to its full identity; past maxPendingRevocations kept predicates it is ended instead
   * (fail closed), and counted only when the predicate matches its empty context, as a WebSocket
   * socket closed at the cap is. A predicate that throws is logged and that stream is skipped.
   */
  closeWhere(predicate: ConnectionPredicate): number {
    let count = 0;
    for (const connection of [...this.#open]) {
      if (!connection.initDone) {
        const kept = this.#deferred.get(connection) ?? [];
        if (kept.length >= this.#host.maxPendingRevocations) {
          // Too many to keep: end it rather than let one escape.
          const matches = this.#matches(connection, predicate);
          this.#end(connection);
          if (matches) count++;
          continue;
        }
        kept.push(predicate);
        this.#deferred.set(connection, kept);
      }
      if (this.#matches(connection, predicate)) {
        this.#end(connection);
        count++;
      }
    }
    return count;
  }

  /**
   * Applies the predicates kept while onConnect was pending, once `connection.context` is set:
   * false when one matches (the stream must not start).
   */
  settle(connection: SseConnection): boolean {
    const kept = this.#deferred.get(connection) ?? [];
    this.#deferred.delete(connection);
    return !kept.some((predicate) => this.#matches(connection, predicate));
  }

  #matches(connection: SseConnection, predicate: ConnectionPredicate): boolean {
    try {
      // Truthy revokes, as for WebSocket sockets: a revocation errs towards ending the stream.
      return Boolean(predicate({ http: connection.http, context: connection.context }));
    } catch (error) {
      logInternalError(
        this.#host.masking,
        'GraphQLSubscriptions.closeWhere predicate threw',
        error,
      );
      return false;
    }
  }

  /** Ends a stream once: it leaves the set now, so a later closeWhere does not count it again. */
  #end(connection: SseConnection): void {
    this.delete(connection);
    connection.end();
  }
}

/** A request error, answered as JSON (never a 200 stream, which the client would read as one). */
function requestError(runtime: GraphQLRuntime, response: GraphQLResponse<unknown>): Response {
  return new Response(JSON.stringify(response), {
    status: noDataStatus(response),
    headers: jsonHeaders(runtime, 'application/json'),
  });
}

/** Leaven's default keep-alive interval, the most a derived interval uses. */
const DEFAULT_KEEP_ALIVE = 8000;

/**
 * The keep-alive interval of a stream: the explicit `subscriptions.sse.keepAliveInterval` (checked
 * against the idle timeout at listen()), or else half the HTTP idleTimeout, at most 8000 ms
 * (8000 when there is no idle timeout), so Bun never closes a quiet stream.
 */
function keepAliveOf(
  runtime: GraphQLRuntime,
  sse: { keepAliveInterval: number; explicit: boolean },
) {
  if (sse.explicit) return sse.keepAliveInterval;
  const max = runtime.streams.maxKeepAliveMs;
  return max === undefined ? DEFAULT_KEEP_ALIVE : Math.min(DEFAULT_KEEP_ALIVE, max);
}

const EMPTY_CONTEXT: Readonly<Record<PropertyKey, unknown>> = Object.freeze({});

const FORBIDDEN = JSON.stringify({
  errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
});

/** Throws for an operation the onExecute check refused on this transport, as the JSON path does. */
function assertNotRejected(op: OperationContext, allowed: readonly OperationKind[]): void {
  const rejected = op.rejectedOperation;
  if (!rejected) return;
  const message = rejectionMessage(rejected, allowed);
  if (rejected === 'mutation') {
    throw new MethodNotAllowedException(message, { headers: { allow: 'POST' } });
  }
  throw new BadRequestException(message);
}

/**
 * The operation type the request selects, or undefined when the document does not parse (under
 * the executor's parser limits) or selects no single operation: execute() then answers the
 * request error. executor.parse() reads Leaven's document cache, which execute() and subscribe()
 * fill, so a document is parsed twice on a cache miss: its first request, or every request for a
 * document that fails to parse or to validate (only validated documents are cached), bounded by
 * maxQueryLength and parseOptions.maxTokens.
 */
async function operationKind(
  runtime: GraphQLRuntime,
  request: GraphQLRequest,
): Promise<OperationKind | undefined> {
  try {
    const document = await runtime.executor.parse(request.query);
    return getOperationAST(document, request.operationName ?? null)?.operation as
      | OperationKind
      | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers a GraphQL request over SSE (graphql-sse distinct connections mode): a query or
 * mutation as one `next` and `complete`, a subscription as one `next` per result and then
 * `complete`. Request errors are JSON at 400 (500 for INTERNAL_SERVER_ERROR).
 */
export async function handleSse(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  request: GraphQLRequest,
  method: 'POST' | 'GET',
): Promise<Response> {
  const { sse, allowedOrigins } = runtime.options;
  if (sse === false) throw new Error('GraphQL SSE is disabled; handleSse must not be called.');
  const keepAliveInterval = keepAliveOf(runtime, sse);
  const headers = ctx.req.headers;
  if (!originAllowed(headers.get('origin'), headers.get('host'), ctx.secure, allowedOrigins)) {
    throw new ForbiddenException('Cross-origin GraphQL SSE requests are not allowed.');
  }
  const kind = await operationKind(runtime, request);
  // Without a Subscription type, execute() answers the validation error: no slot, no onConnect.
  if (kind === 'subscription' && runtime.schema.getSubscriptionType()) {
    return subscribe(runtime, ctx, request, keepAliveInterval);
  }
  const allowed: OperationKind[] = method === 'GET' ? ['query'] : ['query', 'mutation'];
  if (kind === 'mutation' && method === 'GET') {
    throw new MethodNotAllowedException(rejectionMessage('mutation', allowed), {
      headers: { allow: 'POST' },
    });
  }
  const op = await runtime.createOperationContext(ctx, allowed);
  op.operationName = request.operationName;
  const { response } = await runtime.executor.execute(request, op);
  assertNotRejected(op, allowed);
  if (runtime.executor.isRequestError(response)) return requestError(runtime, response);
  return createEventStreamResponse(response, { keepAliveInterval });
}

/**
 * The connection identity of an SSE subscription, computed as for a WebSocket connection_init:
 * the `context(http)` factory, then `onConnect(http, {})`. `false` when either refuses (a throw
 * fails closed and is logged). Neither runs once `signal` is aborted (the stream has ended).
 */
async function connect(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  signal: AbortSignal,
): Promise<{ base: object | undefined; extra: object | undefined } | false> {
  const { options } = runtime;
  let base: object | undefined;
  if (options.context) {
    try {
      base = await options.context(ctx);
    } catch (error) {
      logInternalError(
        runtime.masking,
        'GraphQL context factory threw for an SSE subscription; rejecting it',
        error,
      );
      return false;
    }
  }
  let extra: object | undefined;
  const onConnect = options.subscriptions === false ? undefined : options.subscriptions.onConnect;
  // The stream ended (client gone, revoked, shutdown) while the factory ran: no onConnect work.
  if (signal.aborted) return false;
  if (onConnect) {
    try {
      const result = await onConnect(ctx, {} as ConnectionParams);
      if (result === false) return false;
      if (typeof result === 'object' && result !== null) extra = result;
    } catch (error) {
      logInternalError(
        runtime.masking,
        'GraphQL subscriptions onConnect threw for an SSE subscription; rejecting it',
        error,
      );
      return false;
    }
  }
  return { base, extra };
}

async function subscribe(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  request: GraphQLRequest,
  keepAliveInterval: number,
): Promise<Response> {
  const abort = new AbortController();
  const end = () => abort.abort();
  const connection: SseConnection = { http: ctx, context: EMPTY_CONTEXT, end, initDone: false };
  // The slot is taken before onConnect, as a WebSocket upgrade reserves one, and returned only
  // once onConnect has settled, so pending onConnect calls are bounded by the connection limits
  // even when clients abort. Throws 429 / 503 past them.
  runtime.streams.openStream(connection, ctx.ip, end);
  runtime.sse.add(connection);
  const { subscriptions } = runtime.options;
  const lifetime = subscriptions === false ? undefined : subscriptions.maxConnectionLifetime;
  // At the limit the stream ends (no complete), so the client reconnects and passes onConnect
  // again; counted from the slot, as a WebSocket's lifetime is from open.
  const expiry = lifetime === undefined ? undefined : setTimeout(end, lifetime);
  const signal = ctx.req.signal;
  let detached = false;
  /** Forgets the stream (timers, listener, revocation); its slot is returned separately. */
  const detach = () => {
    if (detached) return;
    detached = true;
    clearTimeout(expiry);
    signal.removeEventListener('abort', end);
    runtime.sse.delete(connection);
  };
  const release = () => {
    detach();
    runtime.streams.closeStream(connection);
  };
  // The client going away ends the stream, also while the subscription is being set up.
  signal.addEventListener('abort', end, { once: true });
  if (signal.aborted) end();
  if (abort.signal.aborted) {
    // Already gone: no context factory or onConnect work for it.
    release();
    throw new ServiceUnavailableException('The subscription ended before it started.');
  }
  // connect() never throws: a refusing or throwing factory or onConnect is `false`. A pending
  // onConnect does not hold the request once the stream is ended (shutdown, client gone) or
  // after connectionInitTimeout, but it keeps the slot until it settles.
  const connecting = connect(runtime, ctx, abort.signal);
  const initTimeout =
    (subscriptions === false ? undefined : subscriptions.connectionInitTimeout) ??
    DEFAULT_CONNECTION_INIT_TIMEOUT;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<'ended' | 'timeout'>((resolve) => {
    abort.signal.addEventListener('abort', () => resolve('ended'), { once: true });
    initTimer = setTimeout(() => resolve('timeout'), initTimeout);
  });
  const accepted = await Promise.race([connecting, stopped]);
  clearTimeout(initTimer);
  if (accepted === 'ended' || accepted === 'timeout') {
    detach();
    // Skips onConnect if the factory is still running; the slot comes back when it settles.
    end();
    void connecting.finally(() => runtime.streams.closeStream(connection));
    throw new ServiceUnavailableException(
      accepted === 'timeout'
        ? 'The subscription did not start within connectionInitTimeout.'
        : 'The subscription ended before it started.',
    );
  }
  if (accepted) connection.context = Object.freeze({ ...accepted.base, ...accepted.extra });
  connection.initDone = true;
  // A closeWhere issued while onConnect was pending is applied now, to the full identity.
  if (!accepted || !runtime.sse.settle(connection)) {
    release();
    return new Response(FORBIDDEN, {
      status: 403,
      headers: jsonHeaders(runtime, 'application/json'),
    });
  }
  const { extra } = accepted;
  let result: Awaited<ReturnType<GraphQLRuntime['executor']['subscribe']>>;
  try {
    const op = await runtime.createOperationContext(ctx, ['subscription'], extra);
    op.operationName = request.operationName;
    result = await runtime.executor.subscribe(request, op);
  } catch (error) {
    release();
    throw error;
  }
  if (!isSubscriptionIterator(result)) {
    // Nothing streams: the slot is not needed.
    release();
    if (runtime.executor.isRequestError(result)) return requestError(runtime, result);
    return createEventStreamResponse(result, { keepAliveInterval });
  }
  // An already aborted signal (the client left, or end() ran) makes the stream return the
  // iterator and close at once.
  return withOpeningComment(
    createEventStreamResponse(result, {
      signal: abort.signal,
      keepAliveInterval,
      formatError: (error) =>
        toSafeError(error, runtime.masking, 'a GraphQL SSE subscription').toGraphQLError().toJSON(),
      onClose: () => {
        release();
        // Leaven returns the iterator only when the stream ends early; after the iterator threw
        // it does not, and the event source (its topic subscriptions) would stay open.
        const iterator = result as AsyncIterator<unknown>;
        try {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        } catch {
          // The iterator is being discarded.
        }
      },
    }),
  );
}

const OPENING_COMMENT = new TextEncoder().encode(':\n\n');

/**
 * `response` with a comment (`:`, which clients ignore) sent first. Bun writes the status and
 * headers with the first body chunk, so without it a client would wait for the first event or
 * keep-alive to learn the subscription started. Cancelling the body cancels the original one.
 */
function withOpeningComment(response: Response): Response {
  const source = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(OPENING_COMMENT);
    },
    async pull(controller) {
      const { value, done } = await source.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}
