import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MASKED_MESSAGE } from '@hpmws/graphql';
import { AuthorsById } from '../src/blog/blog.loaders.js';
import { frontend, type Started, start } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await start();
});
afterAll(async () => {
  await s.mod.close();
});

const csrf = { 'x-graphql-request': '1' };

describe('REST next to GraphQL', () => {
  test('GET /health is a plain controller route', async () => {
    const res = await s.app.request('GET', '/health', { headers: { origin: frontend } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      posts: 4,
      pubsub: process.env.REDIS_URL ? 'redis' : 'memory',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(frontend);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    // @SkipRateLimit(): health checks never use up the budget.
    expect(res.headers.get('ratelimit-limit')).toBeNull();
  });
});

describe('GraphQL over HTTP: CSRF rules', () => {
  test('GET queries need a CSRF header (400 without)', async () => {
    const query = { query: '{ authors { id } }' };
    expect((await s.app.request('GET', '/graphql', { query })).status).toBe(400);
    const ok = await s.app.request('GET', '/graphql', { query, headers: csrf });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: unknown }).data).toEqual({
      authors: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
    });
  });

  test('GET cannot run a mutation (405)', async () => {
    const res = await s.app.request('GET', '/graphql', {
      query: { query: 'mutation { deletePost(id: "p1") }' },
      headers: { ...csrf, authorization: 'Bearer ada-token' },
    });
    expect(res.status).toBe(405);
    expect((await s.app.graphql('{ post(id: "p1") { id } }')).data).toEqual({ post: { id: 'p1' } });
  });

  test('form POSTs are refused (415)', async () => {
    const res = await s.app.request('POST', '/graphql', {
      body: new URLSearchParams({ query: 'mutation { deletePost(id: "p1") }' }),
      headers: { authorization: 'Bearer ada-token' },
    });
    expect(res.status).toBe(415);
    const text = await s.app.request('POST', '/graphql', {
      body: '{"query":"{ authors { id } }"}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.status).toBe(415);
  });
});

describe('production defaults (NODE_ENV is not development)', () => {
  test('introspection is disabled', async () => {
    const res = await s.app.graphql('{ __schema { queryType { name } } }');
    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('introspection');
  });

  test('the playground is not served', async () => {
    const res = await s.app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});

describe('production defaults: masked errors', () => {
  let broken: Started;
  beforeAll(async () => {
    broken = await start((builder) =>
      builder.overrideProvider(AuthorsById).useValue({
        batchCalls: 0,
        batch: async () => {
          throw new Error('connect ECONNREFUSED db.internal:5432');
        },
      } as unknown as AuthorsById),
    );
  });
  afterAll(async () => {
    await broken.mod.close();
  });

  test('unexpected errors are INTERNAL_SERVER_ERROR with a masked message, and logged', async () => {
    const res = await broken.app.graphql('{ post(id: "p1") { title author { name } } }');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ post: null });
    expect(res.errors?.[0]).toMatchObject({
      message: MASKED_MESSAGE,
      path: ['post', 'author'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(JSON.stringify(res)).not.toContain('db.internal');
    const logged = broken.mod.logs.find((e) => e.level === 'error');
    expect(logged?.message).toBe('GraphQL resolver error at post.author');
    expect(String(logged?.meta[0])).toContain('db.internal');
  });

  test('expected errors keep their message', async () => {
    const res = await broken.app.graphql('{ posts(first: 0) { id } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(res.errors?.[0]?.message).not.toBe(MASKED_MESSAGE);
  });
});
