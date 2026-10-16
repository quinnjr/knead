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
import { isLeavenError } from '@leaven-graphql/errors';
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

/**
 * Leaven `formatExecutionError`: maps framework exceptions to `extensions.code` while the
 * original error is still attached, and masks unexpected errors.
 */
export function createErrorFormatter(options: {
  maskErrors: boolean;
  logger: Logger;
}): (error: GraphQLError) => GraphQLFormattedError {
  return (error) => {
    const json = error.toJSON();
    const original = error.originalError;
    // No path: a request-level error such as variable coercion. Always the client's input.
    if (error.path === undefined) return withCode(json, 'BAD_USER_INPUT');
    // graphql-js argument coercion, or a GraphQLError a resolver threw on purpose.
    if (original === undefined || original instanceof GraphQLError) {
      return withCode(json, 'BAD_USER_INPUT');
    }
    if (isLeavenError(original)) return { ...json, extensions: { ...original.extensions } };
    if (original instanceof HttpException) {
      const entry = HTTP_CODES.find(([type]) => original instanceof type);
      if (entry) {
        return {
          ...json,
          message: original.message,
          extensions: { ...original.extensions, code: entry[1] },
        };
      }
    }
    options.logger.error(`GraphQL resolver error at ${error.path.join('.')}`, original);
    return {
      ...json,
      message: options.maskErrors ? MASKED_MESSAGE : json.message,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    };
  };
}
