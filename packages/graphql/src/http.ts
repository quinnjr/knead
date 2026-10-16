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
import { getOperationAST, parse } from 'graphql';
import { playgroundPage, playgroundResponse } from './playground.js';
import { GraphQLRuntime } from './runtime.js';

export const GRAPHQL_RESPONSE_JSON = 'application/graphql-response+json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the GraphQL-over-HTTP request parameters. */
export function parseGraphQLParams(body: unknown): GraphQLRequest {
  if (Array.isArray(body))
    throw new BadRequestException('Batched GraphQL requests are not supported.');
  if (!isPlainObject(body)) throw new BadRequestException('Expected a JSON object body.');
  const { query, variables, operationName, extensions } = body;
  if (typeof query !== 'string' || query.length === 0) {
    throw new BadRequestException('"query" must be a non-empty string.');
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

/** The operation type, or undefined when the document does not parse (Leaven reports that). */
export function operationTypeOf(request: GraphQLRequest): string | undefined {
  try {
    return getOperationAST(parse(request.query, { noLocation: true }), request.operationName)
      ?.operation;
  } catch {
    return undefined;
  }
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
): Promise<Response> {
  const op = await runtime.createOperationContext(ctx);
  const { response } = await runtime.executor.execute(request, op);
  const graphqlJson = (ctx.req.headers.get('accept') ?? '').includes(GRAPHQL_RESPONSE_JSON);
  // application/json: always 200. application/graphql-response+json: 400 when no data entry.
  const status = graphqlJson && response.data === undefined ? 400 : 200;
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
  const request = parseGraphQLParams(await ctx.json());
  if (operationTypeOf(request) === 'subscription') {
    throw new BadRequestException('Subscriptions are only available over WebSocket.');
  }
  return execute(runtime, ctx, request);
}

export async function handleGet(runtime: GraphQLRuntime, ctx: Ctx): Promise<Response> {
  const { options } = runtime;
  if (options.playground && (ctx.req.headers.get('accept') ?? '').includes('text/html')) {
    const url = new URL(options.path, ctx.req.url);
    let ws: string | undefined;
    if (runtime.subscriptionsEnabled) {
      url.protocol = ctx.secure ? 'wss:' : 'ws:';
      ws = url.toString();
    }
    return playgroundResponse(playgroundPage(options.path, ws));
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
  const request = parseGraphQLParams({
    query: params.get('query'),
    variables: jsonParam(params, 'variables'),
    operationName: params.get('operationName'),
    extensions: jsonParam(params, 'extensions'),
  });
  const operation = operationTypeOf(request);
  if (operation === 'mutation' || operation === 'subscription') {
    throw new MethodNotAllowedException(`A ${operation} cannot be sent over GET; use POST.`, {
      headers: { allow: 'POST' },
    });
  }
  return execute(runtime, ctx, request);
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
