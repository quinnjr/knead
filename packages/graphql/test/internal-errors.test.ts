import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { Int, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

const SECRET = 'redis://admin:pw@cache ECONNREFUSED';

/** A custom document cache whose lookups fail, as a broken Redis cache would. */
const brokenCache = {
  get: () => {
    throw new Error(SECRET);
  },
  set: () => {},
  getWithValidation: () => {
    throw new Error(SECRET);
  },
  setValidation: () => {},
  setWithValidation: () => {},
  has: () => false,
  delete: () => false,
  clear: () => {},
  getStats: () => ({ size: 0, maxSize: 0, hits: 0, misses: 0, hitRate: 0 }),
} as never;

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe("Leaven's own INTERNAL_ERROR", () => {
  test('over HTTP it is masked INTERNAL_SERVER_ERROR, logged, and 500 for graphql-response+json', async () => {
    s = await startGraphQL([M], { cache: brokenCache });
    const res = await s.app.graphql('{ n }');
    expect(JSON.stringify(res)).not.toContain('admin:pw');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(
      s.mod.logs.some(
        (e) => e.level === 'error' && JSON.stringify(e.meta).includes('ECONNREFUSED'),
      ),
    ).toBe(true);
    const strict = await s.app.graphql('{ n }', {
      headers: { accept: 'application/graphql-response+json' },
    });
    expect(strict.status).toBe(500);
  });

  test('over WebSocket it is masked too', async () => {
    s = await startGraphQL([M], { cache: brokenCache });
    const sub = await s.app.graphqlSubscribe('subscription { t }');
    const first = await sub.next();
    expect(JSON.stringify(first.value)).not.toContain('admin:pw');
    expect(first.value?.errors?.[0]?.message).toBe('Internal server error');
    await sub.close();
  });

  test('maskErrors: false shows the message but still relabels the code', async () => {
    s = await startGraphQL([M], { cache: brokenCache, maskErrors: false });
    const res = await s.app.graphql('{ n }');
    expect(res.errors?.[0]).toMatchObject({
      message: SECRET,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});
