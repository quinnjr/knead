// The rejection rules shared by the JSON and SSE paths.
import { describe, expect, test } from 'bun:test';
import { HttpException } from '@knead-js/http';
import { rejectionMessage, throwRejected } from '../src/responses.js';

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
