import { HpmwsError } from '@hpmws/core';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  type Logger,
  NotFoundException,
  TooManyRequestsException,
  UnauthorizedException,
} from '@hpmws/http';
import { type ErrorCode, isLeavenError, LeavenError } from '@leaven-graphql/errors';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

/** Thrown while building the schema at bootstrap; the message names the class and field. */
export class SchemaBuildError extends HpmwsError {}

export interface ArgsValidationIssue {
  arg: string;
  message: string;
  path: string[];
}

/** An args `validate` schema rejected its input; reported as BAD_USER_INPUT with `issues`. */
export class ArgsValidationError extends BadRequestException {
  constructor(readonly issues: ArgsValidationIssue[]) {
    super('Argument validation failed', { extensions: { issues } });
  }
}

const HTTP_CODES: readonly [abstract new (...args: any[]) => HttpException, string][] = [
  [UnauthorizedException, 'UNAUTHENTICATED'],
  [ForbiddenException, 'FORBIDDEN'],
  [NotFoundException, 'NOT_FOUND'],
  [TooManyRequestsException, 'RATE_LIMITED'],
  [BadRequestException, 'BAD_USER_INPUT'],
];

export const MASKED_MESSAGE = 'Internal server error';

function withCode(json: GraphQLFormattedError, fallback: string): GraphQLFormattedError {
  const code = json.extensions?.code;
  return {
    ...json,
    extensions: { ...json.extensions, code: typeof code === 'string' ? code : fallback },
  };
}

/** Errors thrown by resolver code (guards, validation, the method) rather than by graphql-js. */
const RESOLVER_ERRORS = new WeakSet<object>();

/** @internal Records that `error` came from resolver code, then returns it for rethrowing. */
export function markResolverError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) RESOLVER_ERRORS.add(error);
  return error;
}

function httpCode(error: HttpException): string | undefined {
  return HTTP_CODES.find(([type]) => error instanceof type)?.[1];
}

export interface ErrorMaskingOptions {
  maskErrors: boolean;
  logger: Logger;
  /**
   * Development logs the full error object; otherwise only its name, its message truncated to
   * 500 characters and a correlation id are logged. Default false.
   */
  development?: boolean;
}

/** Longest error message logged outside development. */
export const LOGGED_MESSAGE_LENGTH = 500;

function summarize(error: unknown): string {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : undefined;
  const name = typeof record?.name === 'string' ? record.name : record ? 'Error' : typeof error;
  let message: string;
  try {
    message = typeof record?.message === 'string' ? record.message : String(error);
  } catch {
    message = '(unprintable)';
  }
  if (message.length > LOGGED_MESSAGE_LENGTH) {
    message = `${message.slice(0, LOGGED_MESSAGE_LENGTH)}…`;
  }
  return `${name}: ${message}`;
}

/**
 * Logs an unexpected error under a new correlation id and returns the id (sent to the client as
 * `extensions.correlationId`). Outside development the error object itself (its stack, cause and
 * properties, which may hold data) is not logged.
 */
export function logInternalError(
  options: ErrorMaskingOptions,
  message: string,
  error: unknown,
): string {
  const id = crypto.randomUUID();
  if (options.development) options.logger.error(`${message} (correlation id ${id})`, error);
  else options.logger.error(`${message} (correlation id ${id}): ${summarize(error)}`);
  return id;
}

/**
 * Converts an error raised outside resolvers (hooks, context factories, subscription filters)
 * into a LeavenError that is safe to send: framework client errors keep their code and message;
 * anything else is logged and becomes INTERNAL_SERVER_ERROR, masked when `maskErrors`.
 */
export function toSafeError(
  error: unknown,
  options: ErrorMaskingOptions,
  where: string,
): LeavenError {
  if (isLeavenError(error)) return error;
  if (error instanceof HttpException) {
    const code = httpCode(error);
    if (code) {
      return new LeavenError(error.message, code as ErrorCode, {
        extensions: { ...error.extensions },
      });
    }
  }
  const correlationId = logInternalError(options, `GraphQL error in ${where}`, error);
  const message = options.maskErrors || !(error instanceof Error) ? MASKED_MESSAGE : error.message;
  return new LeavenError(message, 'INTERNAL_SERVER_ERROR' as ErrorCode, {
    statusCode: 500,
    extensions: { correlationId },
  });
}

/**
 * Leaven `formatExecutionError`: maps framework exceptions to `extensions.code` while the
 * original error is still attached, and masks unexpected errors.
 */
export function createErrorFormatter(
  options: ErrorMaskingOptions,
): (error: GraphQLError) => GraphQLFormattedError {
  const internal = (error: GraphQLError, json: GraphQLFormattedError): GraphQLFormattedError => {
    const correlationId = logInternalError(
      options,
      `GraphQL resolver error at ${error.path?.join('.') ?? '(no path)'}`,
      error.originalError ?? error,
    );
    return {
      ...json,
      message: options.maskErrors ? MASKED_MESSAGE : json.message,
      extensions: { code: 'INTERNAL_SERVER_ERROR', correlationId },
    };
  };
  return (error) => {
    const json = error.toJSON();
    const original = error.originalError;
    // No path: a request-level error such as variable coercion. Always the client's input.
    if (error.path === undefined) return withCode(json, 'BAD_USER_INPUT');
    if (original instanceof GraphQLError) {
      // A GraphQLError a resolver threw on purpose is shown as is.
      if (RESOLVER_ERRORS.has(original)) return withCode(json, 'BAD_USER_INPUT');
      // graphql-js argument coercion is the client's input; anything else (for example output
      // serialization, which may echo resolver data) is internal.
      if (original.message.startsWith('Argument "')) return withCode(json, 'BAD_USER_INPUT');
      return internal(error, json);
    }
    if (original === undefined) return internal(error, json);
    if (isLeavenError(original)) return { ...json, extensions: { ...original.extensions } };
    if (original instanceof HttpException) {
      const code = httpCode(original);
      if (code) {
        return {
          ...json,
          message: original.message,
          extensions: { ...original.extensions, code },
        };
      }
    }
    return internal(error, json);
  };
}
