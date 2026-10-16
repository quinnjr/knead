import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { Int, Mutation, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

let bumps = 0;

@Resolver()
class R {
  @Query(() => Int) n() {
    return bumps;
  }
  @Mutation(() => Int) bump() {
    return ++bumps;
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

const csrf = { 'x-graphql-request': '1' };

describe('operation type checks run on the document Leaven executes', () => {
  test('a GET mutation that only parses with the configured parseOptions is still 405', async () => {
    s = await startGraphQL([M], {
      parseOptions: { graphqlOptions: { allowLegacyFragmentVariables: true } },
    });
    bumps = 0;
    const res = await s.app.request('GET', '/graphql', {
      headers: csrf,
      query: { query: 'mutation { ...F } fragment F($x: Int = 1) on Mutation { bump }' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(bumps).toBe(0);
  });

  test('operationName picks the operation that is checked', async () => {
    s = await startGraphQL([M]);
    bumps = 0;
    const res = await s.app.request('GET', '/graphql', {
      headers: csrf,
      query: { query: 'query Q { n } mutation W { bump }', operationName: 'W' },
    });
    expect(res.status).toBe(405);
    const ok = await s.app.request('GET', '/graphql', {
      headers: csrf,
      query: { query: 'query Q { n } mutation W { bump }', operationName: 'Q' },
    });
    expect(await ok.json()).toEqual({ data: { n: 0 } });
    expect(bumps).toBe(0);
  });

  test('a subscription over POST is 400 and a GET subscription is 405', async () => {
    s = await startGraphQL([M]);
    expect((await s.app.graphql('subscription { t }')).status).toBe(400);
    const res = await s.app.request('GET', '/graphql', {
      headers: csrf,
      query: { query: 'subscription { t }' },
    });
    expect(res.status).toBe(405);
  });
});

describe('operation selection errors', () => {
  for (const options of [{}, { maxComplexity: 100 }]) {
    const label = JSON.stringify(options);
    test(`a multi-operation document without operationName is BAD_USER_INPUT (${label})`, async () => {
      s = await startGraphQL([M], options);
      const res = await s.app.graphql('query A { n } query B { n }', {
        headers: { accept: 'application/graphql-response+json' },
      });
      expect(res.status).toBe(400);
      expect(res.errors?.[0]).toMatchObject({
        message: 'Must provide operation name if query contains multiple operations.',
        extensions: { code: 'BAD_USER_INPUT' },
      });
    });

    test(`an unknown operationName is BAD_USER_INPUT (${label})`, async () => {
      s = await startGraphQL([M], options);
      const res = await s.app.graphql('query A { n }', {
        operationName: 'Nope',
        headers: { accept: 'application/graphql-response+json' },
      });
      expect(res.status).toBe(400);
      expect(res.errors?.[0]).toMatchObject({
        message: 'Unknown operation named "Nope".',
        extensions: { code: 'BAD_USER_INPUT' },
      });
    });
  }
});

describe('errors outside resolvers are masked', () => {
  test('a throwing execution hook does not leak its message', async () => {
    s = await startGraphQL([M], {
      hooks: {
        onExecute: () => {
          throw new Error('hook secret');
        },
      },
    });
    const res = await s.app.graphql('{ n }');
    expect(res.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(s.mod.logs.some((e) => e.level === 'error')).toBe(true);
  });

  test('graphql-response+json: an internal failure is 500, not 400', async () => {
    s = await startGraphQL([M], {
      hooks: {
        onExecute: () => {
          throw new Error('boom');
        },
      },
    });
    const res = await s.app.graphql('{ n }', {
      headers: { accept: 'application/graphql-response+json' },
    });
    expect(res.status).toBe(500);
  });
});

describe('Accept negotiation', () => {
  test('q=0 refuses graphql-response+json', async () => {
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ nope }', {
      headers: { accept: 'application/graphql-response+json;q=0, application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  test('the higher q wins', async () => {
    s = await startGraphQL([M]);
    const json = await s.app.graphql('{ n }', {
      headers: { accept: 'application/json;q=0.9, application/graphql-response+json;q=0.5' },
    });
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const gql = await s.app.graphql('{ n }', {
      headers: { accept: 'application/json;q=0.5, application/graphql-response+json' },
    });
    expect(gql.headers.get('content-type')).toBe(
      'application/graphql-response+json; charset=utf-8',
    );
  });

  test('a plain fetch (Accept: */*) gets JSON even with the playground on', async () => {
    s = await startGraphQL([M], { playground: true, csrf: false });
    const res = await s.app.request('GET', '/graphql', {
      headers: { accept: '*/*' },
      query: { query: '{ n }' },
    });
    expect(await res.json()).toEqual({ data: { n: 0 } });
  });

  test('a browser navigation gets the playground', async () => {
    s = await startGraphQL([M], { playground: true });
    const res = await s.app.request('GET', '/graphql', {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  test('text/html;q=0 does not get the playground', async () => {
    s = await startGraphQL([M], { playground: true, csrf: false });
    const res = await s.app.request('GET', '/graphql', {
      headers: { accept: 'text/html;q=0, application/json' },
      query: { query: '{ n }' },
    });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('response headers', () => {
  test('cache-control: no-store and nosniff by default, over POST and GET', async () => {
    s = await startGraphQL([M]);
    const post = await s.app.graphql('{ n }');
    expect(post.headers.get('cache-control')).toBe('no-store');
    expect(post.headers.get('x-content-type-options')).toBe('nosniff');
    const get = await s.app.request('GET', '/graphql', {
      headers: csrf,
      query: { query: '{ n }' },
    });
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('cacheControl overrides the header; false omits it', async () => {
    s = await startGraphQL([M], { cacheControl: 'private, max-age=60' });
    expect((await s.app.graphql('{ n }')).headers.get('cache-control')).toBe('private, max-age=60');
    await s.mod.close();
    s = await startGraphQL([M], { cacheControl: false });
    const res = await s.app.graphql('{ n }');
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
