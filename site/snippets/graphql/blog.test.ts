import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from './app.module.js';

let mod: TestingModule;
let app: TestApp;

beforeAll(async () => {
  // development: false keeps production behaviour: masked errors, no schema.graphql written.
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  app = await mod.createApp();
});

afterAll(() => mod.close());

test('lists published posts with their authors', async () => {
  const res = await app.graphql<{ posts: { title: string; author: { name: string } }[] }>(
    'query ($status: PostStatus) { posts(status: $status) { title author { name } } }',
    { variables: { status: 'PUBLISHED' } },
  );
  expect(res.status).toBe(200);
  expect(res.data?.posts[0]).toEqual({
    title: 'Notes on the Analytical Engine',
    author: { name: 'Ada Lovelace' },
  });
});

test('streams published posts to subscribers', async () => {
  const sub = await app.graphqlSubscribe<{ postPublished: { title: string } }>(
    'subscription { postPublished { title } }',
    { connectionParams: { token: 'grace-token' } },
  );
  // graphqlSubscribe resolves on connection_ack; give the server a moment to subscribe.
  await Bun.sleep(50);
  await app.graphql('mutation { createPost(input: { title: "Hello", publish: true }) { id } }', {
    headers: { authorization: 'Bearer grace-token' },
  });
  const event = await sub.next();
  expect(event.value).toEqual({ data: { postPublished: { title: 'Hello' } } });
  await sub.close();
});
