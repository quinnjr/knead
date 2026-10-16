import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BlogModule, Store } from './fixtures/blog.js';
import { type Started, startGraphQL } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await startGraphQL([BlogModule]);
});
afterAll(() => s.mod.close());

describe('HTTP transport', () => {
  test('POST query through the full pipeline', async () => {
    const res = await s.app.graphql(
      'query($id: ID!) { user(id: $id) { name role posts { title } } }',
      {
        variables: { id: 'u1' },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.data).toEqual({
      user: { name: 'Ada', role: 'ADMIN', posts: [{ title: 'Hello' }, { title: 'More' }] },
    });
  });

  test('POST mutation with an input object', async () => {
    const res = await s.app.graphql(
      'mutation { createPost(input: { title: "New", tags: ["x"] }) { title tags author { name } } }',
    );
    expect(res.data).toEqual({
      createPost: { title: 'New', tags: ['x'], author: { name: 'Ada' } },
    });
    expect(s.mod.get(Store).posts.size).toBe(4);
  });

  test('unions resolve by instanceof', async () => {
    const res = await s.app.graphql(
      '{ search(term: "a") { __typename ... on User { name } ... on Post { title } } }',
    );
    expect(res.data?.search).toEqual([
      { __typename: 'User', name: 'Ada' },
      { __typename: 'User', name: 'Grace' },
      { __typename: 'Post', title: 'Again' },
    ]);
  });

  test('operationName selects an operation', async () => {
    const res = await s.app.graphql(
      'query A { post(id: "p1") { title } } query B { post(id: "p2") { title } }',
      {
        operationName: 'B',
      },
    );
    expect(res.data).toEqual({ post: { title: 'Again' } });
  });

  test('POST with a non-JSON content type is 415 (form and text CSRF)', async () => {
    for (const type of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await s.app.request('POST', '/graphql', {
        headers: { 'content-type': type },
        body: 'query={__typename}',
      });
      expect(res.status).toBe(415);
    }
    const none = await s.app.request('POST', '/graphql', { body: '{"query":"{__typename}"}' });
    expect(none.status).toBe(415);
  });

  test('malformed bodies are 400 problem responses', async () => {
    const cases: [string, string][] = [
      ['{bad json', 'Malformed JSON body'],
      ['[]', 'Batched GraphQL requests are not supported.'],
      ['{"query": 1}', '"query" must be a non-empty string.'],
      ['{"query": "{ __typename }", "variables": []}', '"variables" must be an object.'],
      ['{"query": "{ __typename }", "operationName": 3}', '"operationName" must be a string.'],
    ];
    for (const [body, detail] of cases) {
      const res = await s.app.request('POST', '/graphql', {
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toBe(detail);
    }
  });

  test('GET requires a CSRF header', async () => {
    const res = await s.app.request('GET', '/graphql', { query: { query: '{ __typename }' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'GraphQL GET requests must include one of these headers: x-graphql-request.',
    );
  });

  test('GET query with the CSRF header', async () => {
    const res = await s.app.request('GET', '/graphql', {
      headers: { 'x-graphql-request': '1' },
      query: { query: 'query($id: ID!) { post(id: $id) { title } }', variables: '{"id":"p1"}' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { post: { title: 'Hello' } } });
  });

  test('GET mutation is 405 with Allow: POST', async () => {
    const res = await s.app.request('GET', '/graphql', {
      headers: { 'x-graphql-request': '1' },
      query: { query: 'mutation { createPost(input: { title: "x" }) { id } }' },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  test('GET with malformed variables JSON is 400', async () => {
    const res = await s.app.request('GET', '/graphql', {
      headers: { 'x-graphql-request': '1' },
      query: { query: '{ __typename }', variables: '{' },
    });
    expect(res.status).toBe(400);
  });

  test('application/json: request errors are still 200', async () => {
    const res = await s.app.graphql('{ nope }');
    expect(res.status).toBe(200);
    expect(res.errors?.[0]?.message).toBe('Cannot query field "nope" on type "Query".');
  });

  test('application/graphql-response+json: 400 without data, 200 with data', async () => {
    const accept = { accept: 'application/graphql-response+json' };
    const bad = await s.app.graphql('{ nope }', { headers: accept });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toBe(
      'application/graphql-response+json; charset=utf-8',
    );
    const partial = await s.app.graphql('{ user(id: "zz") { name } }', { headers: accept });
    expect(partial.status).toBe(200);
    expect(partial.data).toBeNull();
  });

  test('subscriptions over POST are rejected', async () => {
    const res = await s.app.graphql('subscription { x }');
    expect(res.status).toBe(400);
  });
});

describe('production defaults (NODE_ENV is "test" under bun test)', () => {
  test('introspection is disabled', async () => {
    const res = await s.app.graphql('{ __schema { types { name } } }');
    expect(res.errors?.[0]?.message).toContain('introspection has been disabled');
  });

  test('the playground is not served', async () => {
    const res = await s.app.request('GET', '/graphql', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  test('unexpected errors are masked', async () => {
    const res = await s.app.graphql('{ posts { author { name } } }');
    expect(res.errors).toBeUndefined();
    const store = s.mod.get(Store);
    store.posts.get('p1')!.title = undefined as never;
    const broken = await s.app.graphql('{ post(id: "p1") { title } }');
    expect(broken.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    store.posts.get('p1')!.title = 'Hello';
  });
});
