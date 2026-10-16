import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AuthService } from '../src/auth/auth.js';
import { ada, grace, nextEvent, type Started, start } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await start();
});
afterAll(async () => {
  await s.mod.close();
});

const publish = (headers: Record<string, string>, title: string) =>
  s.app.graphql('mutation($input: CreatePostInput!) { createPost(input: $input) { id } }', {
    variables: { input: { title, body: '<p>New</p>', publish: true } },
    headers,
  });

describe('subscriptions', () => {
  test('connections without a valid token are rejected by onConnect (4403)', async () => {
    await expect(s.app.graphqlSubscribe('subscription { postPublished { id } }')).rejects.toThrow(
      '4403',
    );
    await expect(
      s.app.graphqlSubscribe('subscription { postPublished { id } }', {
        connectionParams: { token: 'forged' },
      }),
    ).rejects.toThrow('4403');
  });

  test('postPublished(authorId) only delivers that author’s posts, with nested fields', async () => {
    type Event = { postPublished: { title: string; author: { id: string } } };
    const sub = await s.app.graphqlSubscribe<Event>(
      'subscription($a: ID) { postPublished(authorId: $a) { title author { id } publishedAt } }',
      { variables: { a: 'a2' }, connectionParams: { token: 'ada-token' } },
    );
    let round = 0;
    // Each round publishes Ada's post first; the filter must skip it.
    const event = await nextEvent(sub, async () => {
      round++;
      await publish(ada, `Ada ${round}`);
      await publish(grace, `Grace ${round}`);
    });
    expect(event.errors).toBeUndefined();
    expect(event.data?.postPublished.author.id).toBe('a2');
    expect(event.data?.postPublished.title).toMatch(/^Grace \d+$/);
    await sub.close();
  });

  test('commentAdded(postId) receives comments added over HTTP', async () => {
    type Event = { commentAdded: { postId: string; body: string; author: { name: string } } };
    const sub = await s.app.graphqlSubscribe<Event>(
      'subscription { commentAdded(postId: "p2") { postId body author { name } } }',
      { connectionParams: { token: 'grace-token' } },
    );
    const event = await nextEvent(sub, () =>
      s.app.graphql(
        'mutation { addComment(postId: "p2", body: "<b>Ship it</b><script>x</script>") { id } }',
        {
          headers: ada,
        },
      ),
    );
    expect(event.data?.commentAdded).toEqual({
      postId: 'p2',
      body: '<b>Ship it</b>',
      author: { name: 'Ada Lovelace' },
    });
    await sub.close();
  });

  test('revoking the token ends a recheckGuards subscription at its next event', async () => {
    // Its own app: the revocation must not affect the other tests.
    const own = await start();
    type Event = { commentAdded: { postId: string } };
    const sub = await own.app.graphqlSubscribe<Event>(
      'subscription { commentAdded(postId: "p2") { postId } }',
      { connectionParams: { token: 'grace-token' } },
    );
    const comment = () =>
      own.app.graphql('mutation { addComment(postId: "p2", body: "hi") { id } }', { headers: ada });
    expect((await nextEvent(sub, comment)).data?.commentAdded).toEqual({ postId: 'p2' });
    expect(own.mod.get(AuthService).revoke('grace-token')).toBe(true);
    await comment();
    const denied = await sub.next();
    expect(denied.value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await sub.next()).done).toBe(true);
    await sub.close();
    await own.mod.close();
  });

  test("commentAdded on someone else's draft is refused at subscribe time", async () => {
    const sub = await s.app.graphqlSubscribe('subscription { commentAdded(postId: "p4") { id } }', {
      connectionParams: { token: 'grace-token' },
    });
    const first = await sub.next();
    expect(
      (first.value as { errors: { extensions?: { code?: string } }[] }).errors[0]?.extensions?.code,
    ).toBe('NOT_FOUND');
    await sub.close();
  });

  test('the author can follow comments on their own draft', async () => {
    type Event = { commentAdded: { postId: string } };
    const sub = await s.app.graphqlSubscribe<Event>(
      'subscription { commentAdded(postId: "p4") { postId } }',
      { connectionParams: { token: 'ada-token' } },
    );
    const event = await nextEvent(sub, () =>
      s.app.graphql('mutation { addComment(postId: "p4", body: "note to self") { id } }', {
        headers: ada,
      }),
    );
    expect(event.data?.commentAdded).toEqual({ postId: 'p4' });
    await sub.close();
  });

  test('queries over the socket are refused', async () => {
    const sub = await s.app.graphqlSubscribe('{ posts { id } }', {
      connectionParams: { token: 'grace-token' },
    });
    const first = await sub.next();
    expect(
      (first.value as { errors: { extensions?: { code?: string } }[] }).errors[0]?.extensions?.code,
    ).toBe('BAD_USER_INPUT');
    await sub.close();
  });
});
