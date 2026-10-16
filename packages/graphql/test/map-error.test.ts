import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { ForbiddenException } from '@knead-js/http';
import { Int, Query, Resolver } from '../src/index.js';
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

  test('a non-function mapError is rejected at bootstrap', async () => {
    await expect(startGraphQL([M], { mapError: 'x' as never })).rejects.toThrow(/mapError/);
  });
});
