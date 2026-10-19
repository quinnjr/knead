import {
  type Ctx,
  ForbiddenException,
  originAllowed,
  ServiceUnavailableException,
} from '@knead-js/http';
import type { GraphQLRequest, GraphQLResponse, SubscriptionIterator } from '@leaven-graphql/core';
import { createEventStreamResponse, isSubscriptionIterator } from '@leaven-graphql/sse';
import {
  type ConnectionIdentity,
  type ConnectionPredicate,
  connectionInitTimeoutOf,
  DeferredRevocations,
  EMPTY_CONTEXT,
  identityContext,
  resolveConnectionIdentity,
  revokes,
} from './connect.js';
import { ExecutionHandoff, OperationContext, type OperationKind } from './context.js';
import { type ErrorMaskingOptions, logInternalError, toSafeError } from './errors.js';
import { SSE_MAX_KEEP_ALIVE } from './options.js';
import {
  acceptQuality,
  GRAPHQL_RESPONSE_JSON,
  jsonHeaders,
  noDataStatus,
  throwRejected,
} from './responses.js';
import { type GraphQLRuntime, sseConnectionsOf, subscribeAgain } from './runtime.js';

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

/**
 * Refuses a cross-origin SSE request (403) unless `subscriptions.allowedOrigins` admits it, as the
 * WebSocket upgrade is refused. http.ts calls it before reading the body.
 */
export function assertSseOrigin(runtime: GraphQLRuntime, ctx: Ctx): void {
  const headers = ctx.req.headers;
  if (
    !originAllowed(
      headers.get('origin'),
      headers.get('host'),
      ctx.secure,
      runtime.options.allowedOrigins,
    )
  ) {
    throw new ForbiddenException('Cross-origin GraphQL SSE requests are not allowed.');
  }
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
  /** closeWhere predicates kept while `onConnect` is pending, applied once it settles. */
  readonly revocations: DeferredRevocations<{ readonly predicate: ConnectionPredicate }>;
}

/** What SseConnections reads from its GraphQLRuntime. */
interface SseConnectionsHost {
  readonly masking: ErrorMaskingOptions;
}

/**
 * The open SSE subscription streams of a GraphQLRuntime, for GraphQLSubscriptions.closeWhere
 * (reached through sseConnectionsOf()). Shutdown ends them through StreamRegistry.endStreams(),
 * which holds their slots.
 */
export class SseConnections {
  readonly #host: SseConnectionsHost;
  readonly #open = new Set<SseConnection>();

  constructor(host: SseConnectionsHost) {
    this.#host = host;
  }

  add(connection: SseConnection): void {
    this.#open.add(connection);
  }

  delete(connection: SseConnection): void {
    this.#open.delete(connection);
    connection.revocations.clear();
  }

  /**
   * Ends (without `complete`) every open stream whose connection matches `predicate` and returns
   * how many. A stream whose onConnect has not settled also keeps the predicate, applied to its
   * full identity once onConnect settles; when it cannot keep another (maxPendingRevocations) it
   * is ended instead (fail closed), and counted only when the predicate matches its empty context,
   * as a WebSocket socket closed at the cap is. A predicate that throws is logged and that stream
   * is skipped.
   */
  closeWhere(predicate: ConnectionPredicate): number {
    let count = 0;
    for (const connection of [...this.#open]) {
      if (!connection.initDone && !connection.revocations.keep({ predicate })) {
        const matches = revokes(predicate, connection, this.#host.masking);
        this.#end(connection);
        if (matches) count++;
        continue;
      }
      if (revokes(predicate, connection, this.#host.masking)) {
        this.#end(connection);
        count++;
      }
    }
    return count;
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

const FORBIDDEN = JSON.stringify({
  errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
});

function forbidden(runtime: GraphQLRuntime): Response {
  return new Response(FORBIDDEN, {
    status: 403,
    headers: jsonHeaders(runtime, 'application/json'),
  });
}

/**
 * `response` (an event stream) with the configured `cacheControl` (Leaven sets
 * `no-cache, no-transform`; with `cacheControl: false` that stays) and `nosniff`, as JSON
 * responses have.
 */
function sseResponse(runtime: GraphQLRuntime, response: Response): Response {
  const cacheControl = runtime.options.cacheControl;
  if (cacheControl !== false) response.headers.set('cache-control', cacheControl);
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

/**
 * The keep-alive interval of a stream: the explicit `subscriptions.sse.keepAliveInterval` (checked
 * against the idle timeout at listen()), or else half the HTTP idleTimeout, at most
 * SSE_MAX_KEEP_ALIVE (which it is when there is no idle timeout), so Bun never closes a quiet
 * stream.
 */
function keepAliveOf(runtime: GraphQLRuntime, sse: { keepAliveInterval: number | undefined }) {
  if (sse.keepAliveInterval !== undefined) return sse.keepAliveInterval;
  const max = runtime.streams.maxKeepAliveMs;
  return max === undefined ? SSE_MAX_KEEP_ALIVE : Math.min(SSE_MAX_KEEP_ALIVE, max);
}

/**
 * Answers a GraphQL request over SSE (graphql-sse distinct connections mode): a query or
 * mutation as one `next` and `complete`, a subscription as one `next` per result and then
 * `complete`. Request errors are JSON at 400 (500 for INTERNAL_SERVER_ERROR). The origin has been
 * checked (assertSseOrigin).
 *
 * One `execute()` call parses, checks (the application's onParse first, then Knead's limits) and
 * validates the document; its onExecute check then dispatches on the operation it selected. A
 * query or mutation runs there, with the `context` factory run just before it. A subscription
 * stops the call (ExecutionHandoff) and is subscribed with the connection slot and onConnect
 * (subscribe()), so an invalid document never takes a slot or runs onConnect.
 */
export async function handleSse(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  request: GraphQLRequest,
  method: 'POST' | 'GET',
): Promise<Response> {
  const { sse } = runtime.options;
  if (sse === false) throw new Error('GraphQL SSE is disabled; handleSse must not be called.');
  const keepAliveInterval = keepAliveOf(runtime, sse);
  const allowed: OperationKind[] = method === 'GET' ? ['query'] : ['query', 'mutation'];
  // Without a Subscription type, the subscription is refused as over JSON: no slot, no onConnect.
  const carried: OperationKind[] = runtime.schema.getSubscriptionType()
    ? [...allowed, 'subscription']
    : allowed;
  const op = new OperationContext(ctx, EMPTY_CONTEXT, carried);
  op.operationName = request.operationName;
  let subscription = false;
  let failure: { error: unknown } | undefined;
  op.beforeExecute = async (operation) => {
    if (operation === 'subscription') {
      subscription = true;
      throw new ExecutionHandoff();
    }
    try {
      op.user = { ...(runtime.options.context ? await runtime.options.context(ctx) : {}) };
    } catch (error) {
      // Answered as the JSON path answers a throwing factory, once the call has returned.
      failure = { error };
      throw new ExecutionHandoff();
    }
  };
  const { response } = await runtime.executor.execute(request, op);
  if (failure) throw failure.error;
  // The request already asked for SSE: the message does not point it there.
  throwRejected(op.rejectedOperation, allowed, method, false);
  if (subscription) return subscribe(runtime, ctx, request, keepAliveInterval);
  if (runtime.executor.isRequestError(response)) return requestError(runtime, response);
  return sseResponse(runtime, createEventStreamResponse(response, { keepAliveInterval }));
}

/**
 * The connection slot of one SSE subscription and what is tied to its lifetime: the
 * GraphQLSubscriptions registration, the `maxConnectionLifetime` timer and the request's abort
 * listener. The slot is taken at construction (429 / 503 past the limits), before the context
 * factory and onConnect run, as a WebSocket upgrade reserves one.
 */
class SseSlot {
  readonly connection: SseConnection;
  readonly #runtime: GraphQLRuntime;
  readonly #abort = new AbortController();
  readonly #request: AbortSignal;
  readonly #end = () => this.#abort.abort();
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #detached = false;
  #released = false;

  constructor(runtime: GraphQLRuntime, ctx: Ctx) {
    this.#runtime = runtime;
    this.#request = ctx.req.signal;
    this.connection = {
      http: ctx,
      context: EMPTY_CONTEXT,
      end: this.#end,
      initDone: false,
      revocations: new DeferredRevocations(runtime.maxPendingRevocations),
    };
    runtime.streams.openStream(this.connection, ctx.ip, this.#end);
    try {
      sseConnectionsOf(runtime).add(this.connection);
      const { subscriptions } = runtime.options;
      const lifetime = subscriptions === false ? undefined : subscriptions.maxConnectionLifetime;
      // At the limit the stream ends (no complete), so the client reconnects and passes onConnect
      // again; counted from the slot, as a WebSocket's lifetime is from open.
      if (lifetime !== undefined) this.#expiry = setTimeout(this.#end, lifetime);
      // The client going away ends the stream, also while the subscription is being set up.
      this.#request.addEventListener('abort', this.#end, { once: true });
      if (this.#request.aborted) this.#end();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  /** Aborted once the stream has ended (client gone, revoked, lifetime, shutdown). */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get ended(): boolean {
    return this.#abort.signal.aborted;
  }

  /** Ends the stream (without `complete`). */
  end(): void {
    this.#end();
  }

  /** Forgets the stream (timer, listener, revocation); the slot is returned separately. */
  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    clearTimeout(this.#expiry);
    this.#request.removeEventListener('abort', this.#end);
    sseConnectionsOf(this.#runtime).delete(this.connection);
  }

  /** Detaches the stream and gives its slot back now. */
  release(): void {
    this.detach();
    if (this.#released) return;
    this.#released = true;
    this.#runtime.streams.closeStream(this.connection);
  }

  /**
   * Ends and detaches the stream now, and gives the slot back once `pending` (a context factory or
   * onConnect still running) settles, so pending work stays bounded by the connection limits.
   */
  releaseAfter(pending: Promise<unknown>): void {
    this.detach();
    this.end();
    const giveBack = () => this.release();
    pending.then(giveBack, giveBack);
  }
}

/**
 * The connection identity of the stream (`false` when refused), or why the request stopped
 * waiting for it: `'ended'` (the stream ended) or `'timeout'` (connectionInitTimeout). In those
 * two cases the slot is given back only once the pending work settles.
 */
async function awaitConnect(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  slot: SseSlot,
): Promise<ConnectionIdentity | false | 'ended' | 'timeout'> {
  const connecting = resolveConnectionIdentity(runtime, {
    http: ctx,
    params: {},
    transport: 'SSE',
    isGone: () => slot.ended,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<'ended' | 'timeout'>((resolve) => {
    slot.signal.addEventListener('abort', () => resolve('ended'), { once: true });
    timer = setTimeout(() => resolve('timeout'), connectionInitTimeoutOf(runtime));
  });
  try {
    const outcome = await Promise.race([connecting, stopped]);
    if (outcome === 'ended' || outcome === 'timeout') slot.releaseAfter(connecting);
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

async function subscribe(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  request: GraphQLRequest,
  keepAliveInterval: number,
): Promise<Response> {
  const slot = new SseSlot(runtime, ctx);
  if (slot.ended) {
    // Already gone: no context factory or onConnect work for it.
    slot.release();
    throw new ServiceUnavailableException('The subscription ended before it started.');
  }
  let identity: Awaited<ReturnType<typeof awaitConnect>>;
  try {
    identity = await awaitConnect(runtime, ctx, slot);
  } catch (error) {
    // awaitConnect does not throw; if it did, nothing is pending any more.
    slot.release();
    throw error;
  }
  if (identity === 'ended' || identity === 'timeout') {
    // awaitConnect gives the slot back once the pending work settles.
    throw new ServiceUnavailableException(
      identity === 'timeout'
        ? 'The subscription did not start within connectionInitTimeout.'
        : 'The subscription ended before it started.',
    );
  }
  const { connection } = slot;
  connection.context = identityContext(identity || undefined);
  connection.initDone = true;
  // A closeWhere issued while onConnect was pending is applied now, to the full identity.
  if (!identity || connection.revocations.settle(connection, runtime.masking)) {
    slot.release();
    return forbidden(runtime);
  }
  let result: Awaited<ReturnType<typeof subscribeAgain>>;
  try {
    const op = await runtime.createOperationContext(ctx, ['subscription'], identity.extra);
    op.operationName = request.operationName;
    result = await subscribeAgain(runtime.executor, request, op);
  } catch (error) {
    slot.release();
    throw error;
  }
  if (!isSubscriptionIterator(result)) {
    // Nothing streams: the slot is not needed.
    slot.release();
    if (runtime.executor.isRequestError(result)) return requestError(runtime, result);
    return sseResponse(runtime, createEventStreamResponse(result, { keepAliveInterval }));
  }
  // An already aborted signal (the client left, or end() ran) makes the stream return the
  // iterator and close at once.
  return sseResponse(
    runtime,
    withOpeningComment(
      createEventStreamResponse(loggingReturn(runtime, result), {
        signal: slot.signal,
        keepAliveInterval,
        formatError: (error) =>
          toSafeError(error, runtime.masking, 'a GraphQL SSE subscription')
            .toGraphQLError()
            .toJSON(),
        // Leaven has returned the iterator (its topic subscriptions) before onClose runs, however
        // the stream ended.
        onClose: () => slot.release(),
      }),
    ),
  );
}

/**
 * `iterator` with a `return()` that logs a failure before rethrowing it: Leaven calls `return()`
 * on every close but has no logger and swallows what it throws (e.g. a failed Redis UNSUBSCRIBE).
 */
function loggingReturn(
  runtime: GraphQLRuntime,
  iterator: SubscriptionIterator<unknown>,
): SubscriptionIterator<unknown> {
  const wrapped: SubscriptionIterator<unknown> = {
    [Symbol.asyncIterator]: () => wrapped,
    next: (...args) => iterator.next(...args),
    return: async (value?: unknown) => {
      try {
        return await iterator.return!(value);
      } catch (error) {
        logInternalError(
          runtime.masking,
          'Ending a GraphQL SSE subscription iterator failed',
          error,
        );
        throw error;
      }
    },
  };
  if (iterator.throw) wrapped.throw = (error) => iterator.throw!(error);
  return wrapped;
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
