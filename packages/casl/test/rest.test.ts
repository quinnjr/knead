import { afterEach, expect, test } from 'bun:test';
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
  createCan,
  ForbiddenError,
  SkipAbility,
} from '../src/index.js';
import { bearer, options } from './fixtures.js';

const posts: Record<string, { id: string; authorId: string }> = {
  '1': { id: '1', authorId: 'alice' },
};

const TypedCan = createCan<'read' | 'update', 'Post'>();

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

  @Get('/typed') @TypedCan('read', 'Post') typed() {
    return 'typed';
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

@Controller('/public')
@UseGuards(AbilityGuard)
@SkipAbility()
class PublicController {
  @Get('/') open() {
    return 'public';
  }

  // The method's @Can() is more specific than the controller's @SkipAbility().
  @Get('/admin') @Can('update', 'Post') admin() {
    return 'admin';
  }

  @Get('/skip-then-can') @SkipAbility() @Can('update', 'Post') skipThenCan() {
    return 'both';
  }

  @Get('/can-then-skip') @Can('update', 'Post') @SkipAbility() canThenSkip() {
    return 'both';
  }
}

@Controller('/guarded')
@UseGuards(AbilityGuard)
@Can('update', 'Post')
class GuardedController {
  @Get('/') guarded() {
    return 'guarded';
  }

  @Get('/open') @SkipAbility() open() {
    return 'open';
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
    controllers: [PostsController, PublicController, GuardedController],
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

test('a missing grant denies everything', async () => {
  const a = await serve();
  const headers = { authorization: 'Bearer alice' };
  expect((await a.request('GET', '/posts', { headers })).status).toBe(403);
});

test('createCan() decorators are enforced like @Can()', async () => {
  const a = await serve();
  expect((await a.request('GET', '/typed', bearer('alice', { posts: 'read' }))).status).toBe(200);
  expect((await a.request('GET', '/typed', bearer('alice', {}))).status).toBe(403);
});

test('a malformed grant denies everything', async () => {
  const a = await serve();
  expect((await a.request('GET', '/posts', bearer('alice', 'posts:admin'))).status).toBe(403);
});

test('@SkipAbility() routes need no identity', async () => {
  const a = await serve();
  expect((await a.request('GET', '/open')).status).toBe(200);
});

test('a method-level decorator wins over the controller-level one', async () => {
  const a = await serve();
  expect((await a.request('GET', '/public')).status).toBe(200);
  expect((await a.request('GET', '/public/admin')).status).toBe(401);
  expect((await a.request('GET', '/public/admin', bearer('alice', { posts: 'read' }))).status).toBe(
    403,
  );
  expect(
    (await a.request('GET', '/public/admin', bearer('admin', { posts: 'write' }))).status,
  ).toBe(200);
  expect((await a.request('GET', '/guarded')).status).toBe(401);
  expect((await a.request('GET', '/guarded/open')).status).toBe(200);
});

test('@SkipAbility() wins over @Can() on the same method, in either order', async () => {
  const a = await serve();
  expect((await a.request('GET', '/public/skip-then-can')).status).toBe(200);
  expect((await a.request('GET', '/public/can-then-skip')).status).toBe(200);
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
