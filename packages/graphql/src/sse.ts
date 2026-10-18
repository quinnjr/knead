import {
  BadRequestException,
  type Ctx,
  ForbiddenException,
  MethodNotAllowedException,
  originAllowed,
} from '@knead-js/http';
import type { GraphQLRequest, GraphQLResponse } from '@leaven-graphql/core';
import { createEventStreamResponse, isSubscriptionIterator } from '@leaven-graphql/sse';
import { getOperationAST } from 'graphql';
import type { OperationContext, OperationKind } from './context.js';
import { logInternalError, toSafeError } from './errors.js';
import { acceptQuality, GRAPHQL_RESPONSE_JSON } from './http.js';
import type { ConnectionParams } from './options.js';
import { type GraphQLRuntime, rejectionMessage } from './runtime.js';

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
  /** The `context(http)` factory result with the object `onConnect` returned merged over it. */
  readonly context: Readonly<Record<PropertyKey, unknown>>;
  /** Ends the stream without `complete`: returns the iterator and closes the response body. */
  end(): void;
  /** Whether `onConnect` has settled. */
  initDone: boolean;
}

/** The open SSE subscription streams of a GraphQLRuntime. */
export class SseConnections {
  readonly #open = new Set<SseConnection>();

  add(connection: SseConnection): void {
    this.#open.add(connection);
  }

  delete(connection: SseConnection): void {
    this.#open.delete(connection);
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

/** A request error, answered as JSON (never a 200 stream, which the client would read as one). */
function requestError(response: GraphQLResponse<unknown>): Response {
  const internal = response.errors?.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR');
  return new Response(JSON.stringify(response), {
    status: internal ? 500 : 400,
    headers: JSON_HEADERS,
  });
}

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
 * request error.
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
  const { sse, subscriptions } = runtime.options;
  if (sse === false) throw new Error('GraphQL SSE is disabled; handleSse must not be called.');
  const { keepAliveInterval } = sse;
  const headers = ctx.req.headers;
  const allowedOrigins = subscriptions === false ? undefined : subscriptions.allowedOrigins;
  if (!originAllowed(headers.get('origin'), headers.get('host'), ctx.secure, allowedOrigins)) {
    throw new ForbiddenException('Cross-origin GraphQL SSE requests are not allowed.');
  }
  const kind = await operationKind(runtime, request);
  if (kind === 'subscription') return subscribe(runtime, ctx, request, keepAliveInterval);
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
  if (runtime.executor.isRequestError(response)) return requestError(response);
  return createEventStreamResponse(response, { keepAliveInterval });
}

/**
 * The connection identity of an SSE subscription, computed as for a WebSocket connection_init:
 * the `context(http)` factory, then `onConnect(http, {})`. `false` when either refuses (a throw
 * fails closed and is logged).
 */
async function connect(
  runtime: GraphQLRuntime,
  ctx: Ctx,
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
  const accepted = await connect(runtime, ctx);
  if (!accepted) return new Response(FORBIDDEN, { status: 403, headers: JSON_HEADERS });
  const { base, extra } = accepted;
  const abort = new AbortController();
  const end = () => abort.abort();
  const connection: SseConnection = {
    http: ctx,
    context: Object.freeze({ ...base, ...extra }),
    end,
    initDone: true,
  };
  // Throws 429 / 503 past the connection limits shared with WebSocket.
  runtime.ws.openStream(connection, ctx.ip, end);
  runtime.sse.add(connection);
  const signal = ctx.req.signal;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', end);
    runtime.ws.closeStream(connection);
    runtime.sse.delete(connection);
  };
  // The client going away ends the stream, also while the subscription is being set up.
  signal.addEventListener('abort', end, { once: true });
  if (signal.aborted) end();
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
    if (runtime.executor.isRequestError(result)) return requestError(result);
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
