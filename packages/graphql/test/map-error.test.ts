import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { ForbiddenException } from '@knead-js/http';
import { Int, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

class Nope extends Error {}

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Query(() => Int) nope(): number {
    throw new Nope('secret detail');
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('mapError', () => {
  test('maps a resolver error to an HttpException before masking', async () => {
    s = await startGraphQL([M], {
      mapError: (e) => (e instanceof Nope ? new ForbiddenException('no') : undefined),
    });
    const res = await s.app.graphql('{ nope }');
    expect(res.errors?.[0]).toMatchObject({ message: 'no', extensions: { code: 'FORBIDDEN' } });
  });

  test('an unmapped error stays a masked internal error', async () => {
    s = await startGraphQL([M], { mapError: () => undefined });
    const res = await s.app.graphql('{ nope }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  test('without the option the error is masked', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ nope }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(JSON.stringify(res)).not.toContain('secret detail');
  });

  test('a throwing mapper is logged, the error is masked and the server keeps serving', async () => {
    s = await startGraphQL([M], {
      mapError: () => {
        throw new Error('mapper broke');
      },
    });
    const res = await s.app.graphql('{ nope }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(JSON.stringify(res)).not.toContain('mapper broke');
    expect(s.mod.logs.some((e) => e.level === 'error' && e.message.includes('mapper broke'))).toBe(
      true,
    );
    expect((await s.app.graphql('{ n }')).data).toEqual({ n: 1 });
  });

  test('maps an error thrown by a hook', async () => {
    s = await startGraphQL([M], {
      hooks: {
        onExecute: () => {
          throw new Nope('hook secret');
        },
      },
      mapError: (e) => (e instanceof Nope ? new ForbiddenException('no') : undefined),
    });
    const res = await s.app.graphql('{ n }');
    expect(res.errors?.[0]).toMatchObject({ message: 'no', extensions: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(res)).not.toContain('hook secret');
  });

  test('maps an error thrown by the context factory over WebSocket', async () => {
    let wsCalls = 0;
    s = await startGraphQL([M], {
      // connection_init succeeds (a failure there rejects the connection); the operation fails.
      context: (http) => {
        if (http.req.headers.get('upgrade') && ++wsCalls > 1) throw new Nope('context secret');
        return {};
      },
      mapError: (e) => (e instanceof Nope ? new ForbiddenException('no') : undefined),
    });
    const sub = await s.app.graphqlSubscribe('subscription { t }');
    const result = await sub.next();
    expect(JSON.stringify(result.value)).not.toContain('context secret');
    // Leaven's WebSocket transport sends only the message of a context failure: the mapped
    // message, where an unmapped error would be 'Internal server error'.
    expect(result.value?.errors?.[0]?.message).toBe('no');
  });

  test('over HTTP, a context factory error is an HTTP problem and is not mapped', async () => {
    let thrown: Error = new ForbiddenException('ctx no');
    s = await startGraphQL([M], {
      context: () => {
        throw thrown;
      },
      mapError: () => new ForbiddenException('mapped'),
    });
    const forbidden = await s.app.graphql('{ n }');
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('content-type')).toContain('application/problem+json');
    expect(forbidden).toMatchObject({ status: 403, detail: 'ctx no' });
    thrown = new Nope('context secret');
    const internal = await s.app.graphql('{ n }');
    expect(internal.status).toBe(500);
    expect(internal.headers.get('content-type')).toContain('application/problem+json');
    expect(JSON.stringify(internal)).not.toContain('context secret');
    expect(JSON.stringify(internal)).not.toContain('mapped');
  });

  test('a mapper throwing on a hook error leaves it masked', async () => {
    s = await startGraphQL([M], {
      hooks: {
        onExecute: () => {
          throw new Nope('hook secret');
        },
      },
      mapError: () => {
        throw new Error('mapper broke');
      },
    });
    const res = await s.app.graphql('{ n }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(JSON.stringify(res)).not.toContain('hook secret');
    expect(JSON.stringify(res)).not.toContain('mapper broke');
    expect(
      s.mod.logs.some((e) => e.level === 'error' && e.message.includes('hooks.onExecute')),
    ).toBe(true);
  });

  test('a non-function mapError is rejected at bootstrap', async () => {
    await expect(startGraphQL([M], { mapError: 'x' as never })).rejects.toThrow(/mapError/);
  });
});
