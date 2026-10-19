import { inject, type Type } from '@knead-js/core';
import {
  BadRequestException,
  Controller,
  type Ctx,
  Get,
  type GuardRef,
  Post,
  requestUrl,
  UnsupportedMediaTypeException,
} from '@knead-js/http';
import type { GraphQLRequest } from '@leaven-graphql/core';
import type { OperationKind } from './context.js';
import { queryTooLongMessage } from './options.js';
import {
  acceptQuality,
  GRAPHQL_RESPONSE_JSON,
  jsonHeaders,
  noDataStatus,
  throwRejected,
} from './responses.js';
import { GraphQLRuntime, sseCarriesSubscriptions } from './runtime.js';
import { assertSseOrigin, handleSse, wantsEventStream } from './sse.js';

/**
 * Route-meta key on the GraphQL endpoint (its POST and GET routes, so also subscription upgrades).
 * The value is a function returning the module's resolver `guards`, which lets an app-wide HTTP
 * guard (an `APP_GUARD`) recognise the endpoint and defer to the guards that run on every root
 * field. `Symbol.for` so packages can read it without importing this one.
 */
export const GRAPHQL_ENDPOINT = Symbol.for('knead:gql:endpoint');

/** The value stored under `GRAPHQL_ENDPOINT`. */
export type GraphQLEndpointGuards = () => readonly GuardRef<any>[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the GraphQL-over-HTTP request parameters; `maxQueryLength` is checked first. */
export function parseGraphQLParams(
  body: unknown,
  maxQueryLength: number | false = false,
): GraphQLRequest {
  if (Array.isArray(body))
    throw new BadRequestException('Batched GraphQL requests are not supported.');
  if (!isPlainObject(body)) throw new BadRequestException('Expected a JSON object body.');
  const { query, variables, operationName, extensions } = body;
  if (typeof query !== 'string' || query.length === 0) {
    throw new BadRequestException('"query" must be a non-empty string.');
  }
  if (maxQueryLength !== false && query.length > maxQueryLength) {
    throw new BadRequestException(queryTooLongMessage(maxQueryLength));
  }
  const request: GraphQLRequest = { query };
  if (variables !== undefined && variables !== null) {
    if (!isPlainObject(variables)) throw new BadRequestException('"variables" must be an object.');
    request.variables = variables;
  }
  if (operationName !== undefined && operationName !== null) {
    if (typeof operationName !== 'string') {
      throw new BadRequestException('"operationName" must be a string.');
    }
    request.operationName = operationName;
  }
  if (extensions !== undefined && extensions !== null) {
    if (!isPlainObject(extensions))
      throw new BadRequestException('"extensions" must be an object.');
    request.extensions = extensions;
  }
  return request;
}

/**
 * True when the client names application/graphql-response+json explicitly and does not prefer
 * application/json; wildcards alone keep the legacy application/json.
 */
export function prefersGraphQLResponse(accept: string | null): boolean {
  const graphql = acceptQuality(accept, GRAPHQL_RESPONSE_JSON, true);
  return graphql > 0 && graphql >= acceptQuality(accept, 'application/json');
}

function mediaType(header: string | null): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/** A plain `host[:port]` or bracketed IPv6 literal with an optional port, and nothing else. */
const PLAIN_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * The playground's WebSocket URL: from the Host header only when it is a plain host[:port]
 * (anything else could inject into the page), otherwise the relative path.
 */
export function subscriptionUrl(ctx: Ctx, path: string): string {
  const host = ctx.req.headers.get('host');
  if (host === null || !PLAIN_HOST.test(host)) return path;
  return `${ctx.secure ? 'wss' : 'ws'}://${host.toLowerCase()}${path}`;
}

function jsonParam(params: URLSearchParams, name: string): unknown {
  const raw = params.get(name);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException(`Malformed JSON in "${name}".`);
  }
}

async function execute(
  runtime: GraphQLRuntime,
  ctx: Ctx,
  request: GraphQLRequest,
  allowed: readonly OperationKind[],
): Promise<Response> {
  const op = await runtime.createOperationContext(ctx, allowed);
  op.operationName = request.operationName;
  const { response } = await runtime.executor.execute(request, op);
  // The operation type is checked by a Leaven onExecute hook on the document Leaven parsed.
  throwRejected(op.rejectedOperation, allowed, ctx.req.method, sseCarriesSubscriptions(runtime));
  const graphqlJson = prefersGraphQLResponse(ctx.req.headers.get('accept'));
  // application/json: always 200. application/graphql-response+json: no data entry is 400 for
  // a request error and 500 only for a server failure (INTERNAL_SERVER_ERROR). normalizeResponse
  // has already rewritten Leaven's codes: BAD_REQUEST is BAD_USER_INPUT (400), INTERNAL_ERROR is
  // INTERNAL_SERVER_ERROR (500).
  const status = graphqlJson && response.data === undefined ? noDataStatus(response) : 200;
  const headers = jsonHeaders(runtime, graphqlJson ? GRAPHQL_RESPONSE_JSON : 'application/json');
  return new Response(JSON.stringify(response), { status, headers });
}

/** Whether SSE is on and the request's Accept header prefers text/event-stream. */
function sseRequested(runtime: GraphQLRuntime, ctx: Ctx): boolean {
  return runtime.options.sse !== false && wantsEventStream(ctx.req.headers.get('accept'));
}

export async function handlePost(runtime: GraphQLRuntime, ctx: Ctx): Promise<Response> {
  const sse = sseRequested(runtime, ctx);
  // Before the body is read, as a WebSocket upgrade's origin is checked before its guards.
  if (sse) assertSseOrigin(runtime, ctx);
  if (mediaType(ctx.req.headers.get('content-type')) !== 'application/json') {
    throw new UnsupportedMediaTypeException(
      'GraphQL POST requests must use Content-Type: application/json.',
    );
  }
  const request = parseGraphQLParams(await ctx.json(), runtime.options.maxQueryLength);
  if (sse) return handleSse(runtime, ctx, request, 'POST');
  return execute(runtime, ctx, request, ['query', 'mutation']);
}

export async function handleGet(runtime: GraphQLRuntime, ctx: Ctx): Promise<Response> {
  const { options } = runtime;
  if (options.playground && acceptQuality(ctx.req.headers.get('accept'), 'text/html', true) > 0) {
    const ws = runtime.subscriptionsEnabled
      ? (options.playgroundSubscriptionEndpoint ?? subscriptionUrl(ctx, options.path))
      : undefined;
    return runtime.playground.serve(options.path, ws);
  }
  const sse = sseRequested(runtime, ctx);
  if (sse) assertSseOrigin(runtime, ctx);
  if (options.csrf !== false) {
    const required = options.csrf.requiredHeaders;
    if (!required.some((name) => ctx.req.headers.has(name))) {
      throw new BadRequestException(
        `GraphQL GET requests must include one of these headers: ${required.join(', ')}.`,
      );
    }
  }
  const params = requestUrl(ctx.req).searchParams;
  const request = parseGraphQLParams(
    {
      query: params.get('query'),
      variables: jsonParam(params, 'variables'),
      operationName: params.get('operationName'),
      extensions: jsonParam(params, 'extensions'),
    },
    options.maxQueryLength,
  );
  if (sse) return handleSse(runtime, ctx, request, 'GET');
  return execute(runtime, ctx, request, ['query']);
}

/** The controller is built per module instance so the path stays configurable. */
export function createGraphQLController(path: string): Type {
  // Filled when the controller is constructed at bootstrap, before any request: the options may
  // come from an async factory, so they are not known when the class is decorated.
  let guards: readonly GuardRef<any>[] = [];
  const endpoint: GraphQLEndpointGuards = () => guards;

  @Controller('', { meta: { [GRAPHQL_ENDPOINT]: endpoint } })
  class GraphQLController {
    readonly #runtime = inject(GraphQLRuntime);

    constructor() {
      guards = this.#runtime.options.guards;
    }

    @Post(path)
    post(ctx: Ctx) {
      return handlePost(this.#runtime, ctx);
    }

    @Get(path)
    get(ctx: Ctx) {
      return handleGet(this.#runtime, ctx);
    }
  }
  return GraphQLController;
}
