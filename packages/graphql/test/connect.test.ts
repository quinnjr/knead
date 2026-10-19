// The connection handshake and deferred revocations shared by the WebSocket and SSE transports.
import { describe, expect, test } from 'bun:test';
import { type Ctx, MemoryLogger, WS_DEFAULTS } from '@knead-js/http';
import {
  DeferredRevocations,
  EMPTY_CONTEXT,
  type HandshakeHost,
  identityContext,
  resolveConnectionIdentity,
  revokes,
} from '../src/connect.js';
import type { GraphQLConnection } from '../src/subscriptions.js';

const http = {} as Ctx;

function host(options: Partial<HandshakeHost['options']> = {}) {
  const logger = new MemoryLogger();
  const value: HandshakeHost = {
    options: { context: undefined, subscriptions: {}, ...options },
    masking: { maskErrors: true, logger },
    logger,
  };
  return { host: value, logger };
}

const connection = (context: Record<string, unknown> = {}): GraphQLConnection => ({
  http,
  context,
});

describe('resolveConnectionIdentity', () => {
  test('the factory result and the onConnect object form the identity', async () => {
    const { host: h } = host({
      context: () => ({ user: 'ada', role: 'reader' }),
      subscriptions: { onConnect: () => ({ role: 'admin' }) as never },
    });
    const identity = await resolveConnectionIdentity(h, {
      http,
      params: {},
      transport: 'SSE',
      isGone: () => false,
    });
    expect(identity).toEqual({ base: { user: 'ada', role: 'reader' }, extra: { role: 'admin' } });
    expect(identityContext(identity || undefined)).toEqual({ user: 'ada', role: 'admin' });
    expect(Object.isFrozen(identityContext(identity || undefined))).toBe(true);
    expect(identityContext(undefined)).toBe(EMPTY_CONTEXT);
  });

  test('onConnect false refuses; a throw from either fails closed and is logged per transport', async () => {
    const refused = host({ subscriptions: { onConnect: () => false } });
    const handshake = { http, params: {}, isGone: () => false };
    expect(await resolveConnectionIdentity(refused.host, { ...handshake, transport: 'SSE' })).toBe(
      false,
    );
    for (const transport of ['WebSocket', 'SSE'] as const) {
      const factory = host({
        context: () => {
          throw new Error('down');
        },
      });
      expect(await resolveConnectionIdentity(factory.host, { ...handshake, transport })).toBe(
        false,
      );
      expect(factory.logger.entries.map((e) => e.message)).toContainEqual(
        expect.stringContaining(
          `GraphQL context factory threw at connection_init; rejecting the ${transport} connection`,
        ),
      );
      const onConnect = host({
        subscriptions: {
          onConnect: () => {
            throw new Error('down');
          },
        },
      });
      expect(await resolveConnectionIdentity(onConnect.host, { ...handshake, transport })).toBe(
        false,
      );
      expect(onConnect.logger.entries.map((e) => e.message)).toContainEqual(
        expect.stringContaining(
          `GraphQL subscriptions onConnect threw; rejecting the ${transport} connection`,
        ),
      );
    }
  });

  test('onConnect is skipped when the connection went away while the factory ran', async () => {
    let gone = false;
    let connects = 0;
    const { host: h } = host({
      context: () => {
        gone = true;
        return {};
      },
      subscriptions: {
        onConnect: () => {
          connects++;
          return true;
        },
      },
    });
    const identity = await resolveConnectionIdentity(h, {
      http,
      params: {},
      transport: 'WebSocket',
      isGone: () => gone,
    });
    expect(identity).toBe(false);
    expect(connects).toBe(0);
  });

  test('past connectionInitTimeout it warns that the slot is held, then logs when it settles', async () => {
    const settle = Promise.withResolvers<boolean>();
    const { host: h, logger } = host({
      subscriptions: { connectionInitTimeout: 20, onConnect: () => settle.promise },
    });
    const pending = resolveConnectionIdentity(h, {
      http,
      params: {},
      transport: 'SSE',
      isGone: () => false,
    });
    await Bun.sleep(40);
    expect(logger.entries.filter((e) => e.level === 'warn').map((e) => e.message)).toEqual([
      'GraphQL SSE subscription: the context factory or onConnect is still pending after 20 ms; its connection slot stays held until it settles.',
    ]);
    settle.resolve(true);
    await pending;
    expect(
      logger.entries.some(
        (e) =>
          e.level === 'debug' &&
          e.message.startsWith(
            'GraphQL SSE subscription: the pending context factory or onConnect settled after',
          ),
      ),
    ).toBe(true);
  });

  test('settling in time logs nothing', async () => {
    const { host: h, logger } = host({
      subscriptions: { connectionInitTimeout: 20, onConnect: () => true },
    });
    await resolveConnectionIdentity(h, {
      http,
      params: {},
      transport: 'WebSocket',
      isGone: () => false,
    });
    await Bun.sleep(40);
    expect(logger.entries).toEqual([]);
  });
});

describe('DeferredRevocations (one cap policy for sockets and streams)', () => {
  const masking = { maskErrors: true, logger: new MemoryLogger() };

  test('keeps up to max; the next is refused and the list stays overflowed', () => {
    const kept = new DeferredRevocations<{ predicate: () => boolean }>(2);
    expect(kept.keep({ predicate: () => false })).toBe(true);
    expect(kept.keep({ predicate: () => false })).toBe(true);
    expect(kept.overflowed).toBe(false);
    expect(kept.keep({ predicate: () => true })).toBe(false);
    expect(kept.overflowed).toBe(true);
    expect(kept.keep({ predicate: () => false })).toBe(false);
    // Nothing is applied any more: the transport ends the connection instead.
    expect(kept.settle(connection(), masking)).toBeUndefined();
  });

  test('the default cap is listen({ websocket }) maxPendingRevocations default', () => {
    const kept = new DeferredRevocations<{ predicate: () => boolean }>(undefined);
    for (let i = 0; i < WS_DEFAULTS.maxPendingRevocations; i++) {
      expect(kept.keep({ predicate: () => false })).toBe(true);
    }
    expect(kept.keep({ predicate: () => false })).toBe(false);
  });

  test('settle returns the first kept revocation that matches the identity, once', () => {
    const kept = new DeferredRevocations<{
      predicate: (c: GraphQLConnection) => boolean;
      id: number;
    }>(10);
    kept.keep({ predicate: (c) => c.context.user === 'grace', id: 1 });
    kept.keep({ predicate: (c) => c.context.user === 'ada', id: 2 });
    kept.keep({ predicate: () => true, id: 3 });
    expect(kept.settle(connection({ user: 'ada' }), masking)?.id).toBe(2);
    expect(kept.settle(connection({ user: 'ada' }), masking)).toBeUndefined();
  });

  test('a throwing predicate is logged and does not revoke; a truthy one does', () => {
    const logger = new MemoryLogger();
    expect(
      revokes(
        () => {
          throw new Error('bad');
        },
        connection(),
        { maskErrors: true, logger },
      ),
    ).toBe(false);
    expect(logger.entries.some((e) => e.message.includes('closeWhere predicate threw'))).toBe(true);
    expect(revokes(() => 1 as never, connection(), masking)).toBe(true);
  });

  test('clear forgets kept revocations', () => {
    const kept = new DeferredRevocations<{ predicate: () => boolean }>(10);
    kept.keep({ predicate: () => true });
    kept.clear();
    expect(kept.settle(connection(), masking)).toBeUndefined();
  });
});
