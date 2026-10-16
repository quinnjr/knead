import { describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { MemoryLogger } from '@hpmws/http';
import { GraphQLError } from 'graphql';
import { createErrorFormatter, Query, Resolver } from '../src/index.js';
import { startGraphQL } from './helpers.js';

describe('createErrorFormatter', () => {
  const format = createErrorFormatter({ maskErrors: true, logger: new MemoryLogger() });

  test('graphql-js argument coercion errors stay BAD_USER_INPUT', () => {
    const raw = new GraphQLError('Argument "n" has invalid value "x".');
    const located = new GraphQLError(raw.message, { path: ['times'], originalError: raw });
    expect(format(located)).toMatchObject({
      message: 'Argument "n" has invalid value "x".',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  test('other graphql-js errors with a path are internal and masked', () => {
    const raw = new GraphQLError('String cannot represent value: { hash: "secret" }');
    const located = new GraphQLError(raw.message, { path: ['leak'], originalError: raw });
    expect(format(located)).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  test('a path without an original error is internal and masked', () => {
    expect(format(new GraphQLError('weird', { path: ['x'] }))).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});

describe('output serialization errors', () => {
  test('a resolver returning an object for a String field is masked', async () => {
    @Resolver()
    class R {
      @Query(() => String) leak() {
        return { passwordHash: '$2b$secret' } as unknown as string;
      }
    }
    @Module({ providers: [R] })
    class M {}
    const s = await startGraphQL([M]);
    try {
      const res = await s.app.graphql('{ leak }');
      expect(JSON.stringify(res)).not.toContain('secret');
      expect(res.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    } finally {
      await s.mod.close();
    }
  });
});
