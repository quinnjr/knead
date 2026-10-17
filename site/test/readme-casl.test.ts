import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Test, type TestingModule } from '@knead-js/testing';
import { AppModule, tokens } from '../snippets/readme/casl.js';

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

beforeAll(() => {
  tokens.set('alice-read', { user: { id: 'alice', admin: false }, grant: 'posts:read' });
  tokens.set('alice-write', { user: { id: 'alice', admin: false }, grant: { posts: 'write' } });
  tokens.set('bob-write', { user: { id: 'bob', admin: false }, grant: ['posts:write'] });
  tokens.set('admin-read', { user: { id: 'root', admin: true }, grant: { posts: 'read' } });
});
afterAll(() => tokens.clear());

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

test('README quick start: the user and the grant must both allow a request', async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  const app = await mod.createApp();

  expect((await app.request('GET', '/posts')).status).toBe(401);
  expect((await app.request('GET', '/posts', as('alice-read'))).status).toBe(200);
  // The grant has no write level: denied although the user owns the post.
  expect((await app.request('PUT', '/posts/1', as('alice-read'))).status).toBe(403);
  expect((await app.request('PUT', '/posts/1', as('alice-write'))).status).toBe(200);
  // The grant allows writing, but the user's condition { authorId } does not match.
  expect((await app.request('PUT', '/posts/1', as('bob-write'))).status).toBe(403);
  // An administrator with a read-only token can only read.
  expect((await app.request('GET', '/posts', as('admin-read'))).status).toBe(200);
  expect((await app.request('PUT', '/posts/1', as('admin-read'))).status).toBe(403);
});
