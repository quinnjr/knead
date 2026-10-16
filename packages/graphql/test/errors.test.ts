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

describe('internal error logging', () => {
  const boom = () => {
    const raw = new Error(`db at postgres://admin:pw@db.internal failed ${'x'.repeat(600)}`);
    raw.name = 'DatabaseError';
    return new GraphQLError('ignored', { path: ['post'], originalError: raw });
  };

  test('outside development: name, a truncated message and a correlation id, no objects', () => {
    const logger = new MemoryLogger();
    const format = createErrorFormatter({ maskErrors: true, logger, development: false });
    const json = format(boom());
    const id = json.extensions?.correlationId;
    expect(typeof id).toBe('string');
    expect(json).toMatchObject({ message: 'Internal server error' });
    const [entry] = logger.entries;
    expect(entry?.meta).toEqual([]);
    expect(entry?.message).toStartWith(
      `GraphQL resolver error at post (correlation id ${id}): DatabaseError: db at`,
    );
    const logged = entry!.message.slice(entry!.message.indexOf('DatabaseError: ') + 15);
    expect(logged.length).toBe(501);
    expect(logged.endsWith('…')).toBe(true);
  });

  test('in development the full error object is logged', () => {
    const logger = new MemoryLogger();
    const format = createErrorFormatter({ maskErrors: false, logger, development: true });
    const json = format(boom());
    const [entry] = logger.entries;
    expect(entry?.message).toBe(
      `GraphQL resolver error at post (correlation id ${json.extensions?.correlationId})`,
    );
    // The full error, redacted (it held a credential URL, so it is printed as its stack text).
    expect(entry?.meta[0]).toContain('DatabaseError: db at postgres://***@db.internal failed');
    expect(entry?.meta[0]).not.toContain('admin:pw');
    const plain = new MemoryLogger();
    const raw = new Error('plain');
    createErrorFormatter({ maskErrors: false, logger: plain, development: true })(
      new GraphQLError('ignored', { path: ['post'], originalError: raw }),
    );
    expect(plain.entries[0]?.meta[0]).toBe(raw);
  });

  test('the summary is redacted before truncation, so a cut URL leaks no password', () => {
    const logger = new MemoryLogger();
    const format = createErrorFormatter({ maskErrors: true, logger, development: false });
    // The 500-character cut lands between "://admin:" and "@".
    const raw = new Error(`${'x'.repeat(470)} postgres://admin:${'s'.repeat(60)}@db failed`);
    format(new GraphQLError('ignored', { path: ['post'], originalError: raw }));
    const message = logger.entries[0]!.message;
    expect(message).toContain('postgres://***@db failed');
    expect(message).not.toContain('admin');
    expect(message).not.toContain('sss');
  });

  test('the application flag decides: startGraphQL runs with development false', async () => {
    @Resolver()
    class R {
      @Query(() => String) crash(): string {
        throw new TypeError('secret detail');
      }
    }
    @Module({ providers: [R] })
    class M {}
    const s = await startGraphQL([M]);
    try {
      const res = await s.app.graphql('{ crash }');
      const id = res.errors?.[0]?.extensions?.correlationId;
      const entry = s.mod.logs.find((e) => e.level === 'error');
      expect(entry?.message).toBe(
        `GraphQL resolver error at crash (correlation id ${id}): TypeError: secret detail`,
      );
      expect(entry?.meta).toEqual([]);
    } finally {
      await s.mod.close();
    }
  });
});
