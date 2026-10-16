import { defineScalar } from '@hpmws/graphql';
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function parse(value: unknown): Date {
  const date = typeof value === 'string' && ISO_8601.test(value) ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    throw new GraphQLError('DateTime must be an ISO-8601 date-time string with a time zone.');
  }
  return date;
}

/**
 * An ISO-8601 date-time. Resolvers return `Date`s. Strings are accepted on output as well,
 * because payloads that went through Redis were serialized as JSON.
 */
export const DateTime = defineScalar<Date>(
  new GraphQLScalarType<Date, string>({
    name: 'DateTime',
    description: 'An ISO-8601 date-time string, such as 2026-01-31T12:00:00.000Z.',
    serialize: (value) => (value instanceof Date ? value : parse(value)).toISOString(),
    parseValue: parse,
    parseLiteral: (ast) => {
      if (ast.kind !== Kind.STRING) throw new GraphQLError('DateTime must be a string.');
      return parse(ast.value);
    },
  }),
);
