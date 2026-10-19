// The rejection rules shared by the JSON and SSE paths, and the SSE iterator shim's logging.
import { describe, expect, test } from 'bun:test';
import { HttpException, MemoryLogger } from '@knead-js/http';
import { rejectionMessage, throwRejected } from '../src/responses.js';
import type { GraphQLRuntime } from '../src/runtime.js';
import { returnAfterThrow } from '../src/sse.js';

function thrown(fn: () => void): HttpException | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  return undefined;
}

describe('throwRejected (JSON and SSE)', () => {
  test('nothing rejected: nothing thrown', () => {
    expect(thrown(() => throwRejected(undefined, ['query'], 'GET', true))).toBeUndefined();
  });

  test('a subscription over POST is a 400', () => {
    const error = thrown(() => throwRejected('subscription', ['query', 'mutation'], 'POST', true));
    expect(error?.status).toBe(400);
    expect(error?.message).toBe(
      'Subscriptions are only available over WebSocket or with Accept: text/event-stream.',
    );
  });

  test('a mutation, or a subscription over GET, is a 405 with Allow: POST', () => {
    for (const rejected of ['mutation', 'subscription'] as const) {
      const error = thrown(() => throwRejected(rejected, ['query'], 'GET', true));
      expect(error?.status).toBe(405);
      expect(error?.headers.get('allow')).toBe('POST');
    }
  });
});

describe('rejectionMessage', () => {
  test('names SSE only when it is on', () => {
    expect(rejectionMessage('subscription', ['query', 'mutation'], true)).toBe(
      'Subscriptions are only available over WebSocket or with Accept: text/event-stream.',
    );
    expect(rejectionMessage('subscription', ['query', 'mutation'], false)).toBe(
      'Subscriptions are only available over WebSocket.',
    );
    expect(rejectionMessage('query', ['subscription'], true)).toBe(
      'Only subscription operations are allowed over WebSocket.',
    );
    expect(rejectionMessage('mutation', ['query'], false)).toBe(
      'A mutation cannot be sent over GET; use POST.',
    );
  });
});

describe('returnAfterThrow (Leaven shim)', () => {
  const runtime = (logger: MemoryLogger) =>
    ({ masking: { maskErrors: true, logger } }) as unknown as GraphQLRuntime;

  test('a return() that rejects or throws is logged', async () => {
    const logger = new MemoryLogger();
    returnAfterThrow(runtime(logger), {
      next: async () => ({ value: undefined, done: true }),
      return: () => Promise.reject(new Error('rejected')),
    });
    returnAfterThrow(runtime(logger), {
      next: async () => ({ value: undefined, done: true }),
      return: () => {
        throw new Error('thrown');
      },
    });
    await Bun.sleep(0);
    const failures = logger.entries.filter((e) =>
      e.message.includes('GraphQL SSE subscription iterator return() failed'),
    );
    expect(failures).toHaveLength(2);
  });

  test('an iterator without return() is fine', async () => {
    const logger = new MemoryLogger();
    returnAfterThrow(runtime(logger), { next: async () => ({ value: undefined, done: true }) });
    await Bun.sleep(0);
    expect(logger.entries).toEqual([]);
  });
});
