import { getMetadata } from '@knead/core';
import type { RequestContext } from './context.js';
import { logError } from './error-log.js';
import {
  ForbiddenException,
  HttpException,
  type ProblemDetails,
  problemResponse,
} from './exceptions.js';
import { type Logger, logValue, redactCredentials, redactValue } from './logger.js';
import { CATCH } from './metadata.js';
import { requestUrl } from './request.js';
import type { ExceptionFilter, Guard, Middleware } from './types.js';

export type Handler = (ctx: RequestContext) => Promise<Response>;
export type ErrorHandler = (error: unknown, ctx: RequestContext) => Promise<Response>;

function nameOf(value: object): string {
  return value.constructor?.name && value.constructor !== Object
    ? value.constructor.name
    : '(anonymous)';
}

/**
 * Composes middleware into an onion. Every layer converts its own throws (and invalid
 * results) into a Response through `onError`, so outer layers always receive a Response.
 */
export function composeMiddleware(
  middleware: readonly Middleware[],
  terminal: Handler,
  onError: ErrorHandler,
): Handler {
  const dispatch = async (index: number, ctx: RequestContext): Promise<Response> => {
    if (index === middleware.length) return terminal(ctx);
    const layer = middleware[index]!;
    let called = false;
    try {
      const res = await layer.use(ctx, () => {
        if (called)
          return Promise.reject(new Error(`next() called multiple times in ${nameOf(layer)}`));
        called = true;
        return dispatch(index + 1, ctx);
      });
      if (!(res instanceof Response))
        throw new TypeError(`${nameOf(layer)} did not return a Response`);
      return res;
    } catch (error) {
      return onError(error, ctx);
    }
  };
  return (ctx) => dispatch(0, ctx);
}

/** A guard passes only when it returns (or resolves to) exactly `true`; anything else is 403. */
export async function runGuards(guards: readonly Guard<any>[], ctx: RequestContext): Promise<void> {
  for (const guard of guards) {
    if ((await guard.canActivate(ctx)) !== true) throw new ForbiddenException();
  }
}

function handles(filter: ExceptionFilter, error: unknown): boolean {
  const types = getMetadata(filter.constructor, CATCH);
  return !types || types.length === 0 || types.some((t) => error instanceof t);
}

export function defaultErrorResponse(
  error: unknown,
  ctx: RequestContext,
  logger: Logger,
  development: boolean,
): Response {
  const instance = requestUrl(ctx.req).pathname;
  const where = `${logValue(ctx.req.method)} ${logValue(instance)}`;
  const log = { logger, development };
  if (error instanceof HttpException) {
    if (error.status < 500) return problemResponse(error.toProblem(instance), error.headers);
    const correlationId = logError(log, `${error.status} on ${where}`, error);
    // Outside development a 5xx carries no detail or extensions: they tend to leak internals.
    const problem: ProblemDetails = development
      ? redactProblem(error.toProblem(instance))
      : { type: error.type, title: error.title, status: error.status, instance };
    problem.correlationId = correlationId;
    return problemResponse(problem, error.headers);
  }
  const correlationId = logError(log, `Unhandled error on ${where}`, error);
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    instance,
    correlationId,
  };
  if (development && error instanceof Error) {
    problem.detail = redactCredentials(error.message);
    problem.stack = error.stack === undefined ? undefined : redactCredentials(error.stack);
  }
  return problemResponse(problem);
}

/** A development 5xx problem with its detail and extensions redacted. */
function redactProblem(problem: ProblemDetails): ProblemDetails {
  return redactValue(problem) as ProblemDetails;
}

/** Filters are tried in order (route → controller → global); the first match wins. */
export function createErrorHandler(
  filters: readonly ExceptionFilter[],
  logger: Logger,
  development: boolean,
): ErrorHandler {
  return async (error, ctx) => {
    for (const filter of filters) {
      if (!handles(filter, error)) continue;
      try {
        const res = await filter.catch(error, ctx);
        if (res instanceof Response) return res;
        logger.error(`Exception filter ${nameOf(filter)} did not return a Response`);
      } catch (filterError) {
        logError({ logger, development }, `Exception filter ${nameOf(filter)} threw`, filterError);
      }
      break;
    }
    return defaultErrorResponse(error, ctx, logger, development);
  };
}
