import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AuthorsById, PostsByAuthor } from '../src/blog/blog.loaders.js';
import { frontend, type Started, start } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await start();
});
afterAll(async () => {
  await s.mod.close();
});

describe('queries', () => {
  test('lists published posts with enum and DateTime fields', async () => {
    const res = await s.app.graphql(
      '{ posts(status: PUBLISHED) { id title status tags publishedAt } }',
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.posts).toEqual([
      {
        id: 'p1',
        title: 'Notes on the Analytical Engine',
        status: 'PUBLISHED',
        tags: ['history'],
        publishedAt: '2026-01-10T09:00:00.000Z',
      },
      {
        id: 'p2',
        title: 'The first actual bug',
        status: 'PUBLISHED',
        tags: ['debugging'],
        publishedAt: '2026-02-01T12:00:00.000Z',
      },
      {
        id: 'p3',
        title: 'The imitation game',
        status: 'PUBLISHED',
        tags: [],
        publishedAt: '2026-03-15T15:30:00.000Z',
      },
    ]);
  });

  test('drafts are listed by the DRAFT enum value; nullable fields are null', async () => {
    const res = await s.app.graphql('{ posts(status: DRAFT) { id status publishedAt } }');
    expect(res.data).toEqual({ posts: [{ id: 'p4', status: 'DRAFT', publishedAt: null }] });
    const bad = await s.app.graphql('{ posts(status: ARCHIVED) { id } }');
    expect(bad.errors?.[0]?.message).toContain('ARCHIVED');
  });

  test('DateTime round-trips through a variable and an inline literal', async () => {
    const query = 'query($since: DateTime) { posts(since: $since) { id createdAt } }';
    const res = await s.app.graphql<{ posts: { id: string; createdAt: string }[] }>(query, {
      variables: { since: '2026-03-01T00:00:00+00:00' },
    });
    expect(res.data?.posts).toEqual([
      { id: 'p3', createdAt: '2026-03-15T15:30:00.000Z' },
      { id: 'p4', createdAt: '2026-04-01T08:00:00.000Z' },
    ]);
    const literal = await s.app.graphql<{ posts: { id: string }[] }>(
      '{ posts(since: "2026-04-01T08:00:00.000Z") { id } }',
    );
    expect(literal.data?.posts).toEqual([{ id: 'p4' }]);
    const invalid = await s.app.graphql(query, { variables: { since: 'last tuesday' } });
    expect(invalid.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(invalid.errors?.[0]?.message).toContain('ISO-8601');
  });

  test('@ArgsType pagination with defaults and validation', async () => {
    const page = await s.app.graphql('{ posts(first: 2, offset: 1) { id } }');
    expect(page.data).toEqual({ posts: [{ id: 'p2' }, { id: 'p3' }] });
    const tooMany = await s.app.graphql('{ posts(first: 500) { id } }');
    expect(tooMany.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(tooMany.errors?.[0]?.extensions?.issues).toEqual([
      expect.objectContaining({ arg: 'first' }),
    ]);
  });

  test('Post.author is batched: one AuthorsById.batch() call for the whole list', async () => {
    const loader = s.mod.get(AuthorsById);
    const before = loader.batchCalls;
    const res = await s.app.graphql<{ posts: { author: { name: string } }[] }>(
      '{ posts { title author { name } } }',
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.posts.map((p) => p.author.name)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Alan Turing',
      'Ada Lovelace',
    ]);
    // Four posts, three distinct authors, one batch.
    expect(loader.batchCalls - before).toBe(1);
  });

  test('Author.posts is batched through PostsByAuthor', async () => {
    const loader = s.mod.get(PostsByAuthor);
    const before = loader.batchCalls;
    const res = await s.app.graphql<{ authors: { name: string; posts: { id: string }[] }[] }>(
      '{ authors { name posts { id } } }',
    );
    expect(res.data?.authors).toEqual([
      { name: 'Ada Lovelace', posts: [{ id: 'p1' }, { id: 'p4' }] },
      { name: 'Grace Hopper', posts: [{ id: 'p2' }] },
      { name: 'Alan Turing', posts: [{ id: 'p3' }] },
    ]);
    expect(loader.batchCalls - before).toBe(1);
  });

  test('search returns a union of Post and Author', async () => {
    const res = await s.app.graphql(
      `{ search(term: "  An ") {
          __typename
          ... on Post { title }
          ... on Author { name }
        } }`,
    );
    expect(res.data).toEqual({
      search: [
        { __typename: 'Post', title: 'Notes on the Analytical Engine' },
        { __typename: 'Author', name: 'Alan Turing' },
      ],
    });
    const short = await s.app.graphql('{ search(term: "a") { __typename } }');
    expect(short.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  test('node(id) resolves the Node interface to its implementation', async () => {
    const res = await s.app.graphql(
      `{ a: node(id: "a2") { __typename id ... on Author { name bio } }
         p: node(id: "p2") { __typename ... on Post { comments { body } } }
         none: node(id: "zzz") { id } }`,
    );
    expect(res.data).toEqual({
      a: { __typename: 'Author', id: 'a2', name: 'Grace Hopper', bio: null },
      p: { __typename: 'Post', comments: [{ body: '<p>Wonderful <em>find</em>.</p>' }] },
      none: null,
    });
  });

  test('GraphQL responses carry CORS, rate-limit and security headers', async () => {
    const res = await s.app.graphql('{ authors { id } }', { headers: { origin: frontend } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(frontend);
    expect(res.headers.get('ratelimit-limit')).toBe('100');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
