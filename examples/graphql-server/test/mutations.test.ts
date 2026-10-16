import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ada, grace, type Started, start } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await start();
});
afterAll(async () => {
  await s.mod.close();
});

const createPost = `mutation($input: CreatePostInput!) {
  createPost(input: $input) { id title body tags status publishedAt author { id name } }
}`;
const deletePost = 'mutation($id: ID!) { deletePost(id: $id) }';

describe('mutations', () => {
  test('without a token: UNAUTHENTICATED, and nothing is created', async () => {
    const res = await s.app.graphql(createPost, {
      variables: { input: { title: 'Anonymous', body: 'hi' } },
    });
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(res.errors?.[0]?.message).toBe('Sign in with a bearer token.');
    const bad = await s.app.graphql(createPost, {
      variables: { input: { title: 'Forged', body: 'hi' } },
      headers: { authorization: 'Bearer forged' },
    });
    expect(bad.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  test('a signed-in author creates a post; input is trimmed and sanitized', async () => {
    const res = await s.app.graphql<{ createPost: Record<string, unknown> }>(createPost, {
      variables: {
        input: {
          title: '  Compilers  ',
          body: '<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(1)>',
          tags: [' Languages '],
        },
      },
      headers: grace,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data?.createPost).toMatchObject({
      title: 'Compilers',
      body: '<p>Hello <b>world</b></p>',
      tags: ['languages'],
      status: 'DRAFT',
      publishedAt: null,
      author: { id: 'a2', name: 'Grace Hopper' },
    });
  });

  test('validation failures are BAD_USER_INPUT with issues', async () => {
    const res = await s.app.graphql(createPost, {
      variables: { input: { title: 'x', body: '<script>only a script</script>' } },
      headers: grace,
    });
    expect(res.data).toBeNull();
    const error = res.errors?.[0];
    expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
    const issues = error?.extensions?.issues as { arg: string; path: string[] }[];
    expect(issues.map((i) => [i.arg, i.path])).toEqual([
      ['input', ['title']],
      ['input', ['body']],
    ]);
  });

  test('publishPost: only the author or an admin', async () => {
    // Someone else's draft is invisible to Grace, so it is reported as not found.
    const hidden = await s.app.graphql('mutation { publishPost(id: "p4") { status } }', {
      headers: grace,
    });
    expect(hidden.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    const forbidden = await s.app.graphql('mutation { publishPost(id: "p1") { status } }', {
      headers: grace,
    });
    expect(forbidden.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const ok = await s.app.graphql('mutation { publishPost(id: "p4") { status publishedAt } }', {
      headers: ada,
    });
    expect(ok.data?.publishPost).toMatchObject({ status: 'PUBLISHED' });
    const missing = await s.app.graphql('mutation { publishPost(id: "p404") { id } }', {
      headers: ada,
    });
    expect(missing.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  test('addComment on a draft the user cannot see is NOT_FOUND', async () => {
    const draft = await s.app.graphql<{ createPost: { id: string } }>(
      'mutation { createPost(input: { title: "Secret plans", body: "tbd" }) { id } }',
      { headers: ada },
    );
    const id = draft.data?.createPost.id;
    const res = await s.app.graphql(
      'mutation($id: ID!) { addComment(postId: $id, body: "hi") { id } }',
      {
        variables: { id },
        headers: grace,
      },
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  test('addComment sanitizes the HTML body', async () => {
    const res = await s.app.graphql(
      'mutation($b: String!) { addComment(postId: "p1", body: $b) { postId body author { name } } }',
      {
        variables: { b: '<em>Brilliant</em> <a href="javascript:alert(1)">link</a>' },
        headers: grace,
      },
    );
    expect(res.data?.addComment).toEqual({
      postId: 'p1',
      body: '<em>Brilliant</em> <a rel="noopener noreferrer">link</a>',
      author: { name: 'Grace Hopper' },
    });
  });

  test('deletePost needs @Roles("admin"): UNAUTHENTICATED, then FORBIDDEN, then allowed', async () => {
    const anonymous = await s.app.graphql(deletePost, { variables: { id: 'p3' } });
    expect(anonymous.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    const author = await s.app.graphql(deletePost, { variables: { id: 'p3' }, headers: grace });
    expect(author.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const admin = await s.app.graphql(deletePost, { variables: { id: 'p3' }, headers: ada });
    expect(admin.data).toEqual({ deletePost: true });
    const gone = await s.app.graphql('{ post(id: "p3") { id } }');
    expect(gone.data).toEqual({ post: null });
  });
});
