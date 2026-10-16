import { afterEach, expect, test } from 'bun:test';
import { ForbiddenError } from '@casl/ability';
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Get, Put, UseGuards } from '@knead-js/http';
import { Test, type TestApp } from '@knead-js/testing';
import {
  AbilityGuard,
  AbilityService,
  asSubject,
  Can,
  CaslModule,
  createAppAbility,
  SkipAbility,
} from '../src/index.js';
import { bearer, options } from './fixtures.js';

const posts: Record<string, { id: string; authorId: string }> = {
  '1': { id: '1', authorId: 'alice' },
};

@Controller()
@UseGuards(AbilityGuard)
class PostsController {
  readonly #abilities = inject(AbilityService);

  @Get('/posts') @Can('read', 'Post') list() {
    return Object.values(posts);
  }

  @Put('/posts/:id') @Can('update', 'Post') async update(ctx: Ctx<{ params: { id: string } }>) {
    const post = posts[ctx.params.id]!;
    await this.#abilities.authorize(ctx, 'update', asSubject('Post', post));
    return post;
  }

  @Get('/open') @SkipAbility() open() {
    return 'open';
  }

  @Get('/undeclared') undeclared() {
    return 'undeclared';
  }

  @Get('/boom') @SkipAbility() boom() {
    throw ForbiddenError.from(createAppAbility([])).setMessage('x');
  }
}

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(): Promise<TestApp> {
  const mod = await Test.createModule({
    imports: [CaslModule.forRoot(options)],
    controllers: [PostsController],
  }).compile();
  app = await mod.createApp();
  return app;
}

test('no identity is a 401', async () => {
  const a = await serve();
  expect((await a.request('GET', '/posts')).status).toBe(401);
});

test('an empty grant allows nothing', async () => {
  const a = await serve();
  expect((await a.request('GET', '/posts', bearer('alice', {}))).status).toBe(403);
});

test('a read grant allows reading but not updating', async () => {
  const a = await serve();
  const grant = { posts: 'read' };
  expect((await a.request('GET', '/posts', bearer('alice', grant))).status).toBe(200);
  expect((await a.request('PUT', '/posts/1', bearer('alice', grant))).status).toBe(403);
});

test('a write grant keeps the owner-only condition', async () => {
  const a = await serve();
  const grant = { posts: 'write' };
  expect((await a.request('PUT', '/posts/1', bearer('alice', grant))).status).toBe(200);
  expect((await a.request('PUT', '/posts/1', bearer('bob', grant))).status).toBe(403);
});

test('an admin is still limited by the grant', async () => {
  const a = await serve();
  expect((await a.request('PUT', '/posts/1', bearer('admin', { posts: 'read' }))).status).toBe(403);
});

test('a malformed grant denies everything', async () => {
  const a = await serve();
  expect((await a.request('GET', '/posts', bearer('alice', 'posts:admin'))).status).toBe(403);
});

test('@SkipAbility() routes need no identity', async () => {
  const a = await serve();
  expect((await a.request('GET', '/open')).status).toBe(200);
});

test('a guarded route without @Can() fails closed', async () => {
  const a = await serve();
  const res = await a.request('GET', '/undeclared', bearer('admin', { posts: 'write' }));
  expect(res.status).toBe(403);
});

test('a raw CASL ForbiddenError is a 403 problem, not a 500', async () => {
  const a = await serve();
  const res = await a.request('GET', '/boom');
  expect(res.status).toBe(403);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status).toBe(403);
  expect(body.detail).toBeUndefined();
});
