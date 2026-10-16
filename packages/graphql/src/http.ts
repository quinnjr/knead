import { inject, type Type } from '@hpmws/core';
import {
  BadRequestException,
  Controller,
  type Ctx,
  Get,
  MethodNotAllowedException,
  Post,
  UnsupportedMediaTypeException,
} from '@hpmws/http';
import type { GraphQLRequest } from '@leaven-graphql/core';
import type { OperationKind } from './context.js';
import { queryTooLongMessage } from './options.js';
import { GraphQLRuntime, rejectionMessage } from './runtime.js';

export const GRAPHQL_RESPONSE_JSON = 'application/graphql-response+json';

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

/** The q value Accept gives `type`: an exact range wins over a type wildcard, then any. */
export function acceptQuality(accept: string | null, type: string, exact = false): number {
  if (accept === null || accept.trim() === '') return type === 'application/json' ? 1 : 0;
  const major = `${type.split('/')[0]}/*`;
  let best = -1;
  let specificity = -1;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';').map((p) => p.trim().toLowerCase());
    const rank = range === type ? 2 : exact ? -1 : range === major ? 1 : range === '*/*' ? 0 : -1;
    if (rank < specificity || rank < 0) continue;
    const q = params.find((p) => p.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    if (rank > specificity || quality > best) best = Number.isFinite(quality) ? quality : 0;
    specificity = rank;
  }
  return Math.max(best, 0);
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
  if (op.rejectedOperation) {
    const message = rejectionMessage(op.rejectedOperation, allowed);
    if (op.rejectedOperation === 'subscription' && ctx.req.method !== 'GET') {
      throw new BadRequestException(message);
    }
    throw new MethodNotAllowedException(message, { headers: { allow: 'POST' } });
  }
  const graphqlJson = prefersGraphQLResponse(ctx.req.headers.get('accept'));
  // application/json: always 200. application/graphql-response+json: no data entry is 400 for
  // a request error and 500 only for a genuine server failure (INTERNAL_SERVER_ERROR; Leaven's
  // own INTERNAL_ERROR comes from compiling or validating the request).
  let status = 200;
  if (graphqlJson && response.data === undefined) {
    const internal = response.errors?.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR');
    status = internal ? 500 : 400;
  }
  return new Response(JSON.stringify(response), {
    status,
    headers: {
      'content-type': `${graphqlJson ? GRAPHQL_RESPONSE_JSON : 'application/json'}; charset=utf-8`,
    },
  });
}

export async function handlePost(runtime: GraphQLRuntime, ctx: Ctx): Promise<Response> {
  if (mediaType(ctx.req.headers.get('content-type')) !== 'application/json') {
    throw new UnsupportedMediaTypeException(
      'GraphQL POST requests must use Content-Type: application/json.',
    );
  }
  const request = parseGraphQLParams(await ctx.json(), runtime.options.maxQueryLength);
  return execute(runtime, ctx, request, ['query', 'mutation']);
}

export async function handleGet(runtime: GraphQLRuntime, ctx: Ctx): Promise<Response> {
  const { options } = runtime;
  if (options.playground && acceptQuality(ctx.req.headers.get('accept'), 'text/html', true) > 0) {
    const url = new URL(options.path, ctx.req.url);
    let ws: string | undefined;
    if (runtime.subscriptionsEnabled) {
      url.protocol = ctx.secure ? 'wss:' : 'ws:';
      ws = url.toString();
    }
    return runtime.playground.serve(options.path, ws);
  }
  if (options.csrf !== false) {
    const required = options.csrf.requiredHeaders;
    if (!required.some((name) => ctx.req.headers.has(name))) {
      throw new BadRequestException(
        `GraphQL GET requests must include one of these headers: ${required.join(', ')}.`,
      );
    }
  }
  const params = new URL(ctx.req.url).searchParams;
  const request = parseGraphQLParams(
    {
      query: params.get('query'),
      variables: jsonParam(params, 'variables'),
      operationName: params.get('operationName'),
      extensions: jsonParam(params, 'extensions'),
    },
    options.maxQueryLength,
  );
  return execute(runtime, ctx, request, ['query']);
}

/** The controller is built per module instance so the path stays configurable. */
export function createGraphQLController(path: string): Type {
  @Controller()
  class GraphQLController {
    readonly #runtime = inject(GraphQLRuntime);

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
