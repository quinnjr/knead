import { describe, expect, test } from 'bun:test';
import { AuthService, ROLES, RolesGuard } from '../src/auth/auth.js';
import { toCommentEvent, toPostEvent } from '../src/blog/blog.events.js';
import {
  Comment,
  isCommentEvent,
  isPostEvent,
  Post,
  PostStatus,
  reviveComment,
  revivePost,
} from '../src/blog/blog.types.js';
import { listenOptions, redisPubSubOptions } from '../src/config.js';

describe('demo AuthService', () => {
  test('refuses to start with NODE_ENV=production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new AuthService()).toThrow(/demo tokens.*NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(() => new AuthService()).not.toThrow();
  });
});

describe('listen options', () => {
  test('bind to HOST, default 127.0.0.1', () => {
    expect(listenOptions({})).toEqual({ hostname: '127.0.0.1', port: 3000 });
    expect(listenOptions({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({
      hostname: '0.0.0.0',
      port: 8080,
    });
  });
});

describe('event payloads', () => {
  const post = Object.assign(new Post(), {
    id: 'p9',
    title: 'T',
    body: '<p>b</p>',
    status: PostStatus.PUBLISHED,
    tags: ['x'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: new Date('2026-01-02T00:00:00Z'),
    authorId: 'a1',
    internalNotes: 'secret',
  });

  test('publish DTOs with explicit fields, not entities', () => {
    const event = toPostEvent(post);
    expect(Object.keys(event).sort()).toEqual(
      ['authorId', 'body', 'createdAt', 'id', 'publishedAt', 'status', 'tags', 'title'].sort(),
    );
    expect(event).not.toBeInstanceOf(Post);
    const comment = Object.assign(new Comment(), {
      id: 'c1',
      postId: 'p9',
      authorId: 'a2',
      body: 'hi',
      createdAt: new Date(),
      extra: 'secret',
    });
    expect(Object.keys(toCommentEvent(comment)).sort()).toEqual(
      ['authorId', 'body', 'createdAt', 'id', 'postId'].sort(),
    );
  });

  test('revive copies explicit fields only', () => {
    const raw = JSON.parse(JSON.stringify({ ...toPostEvent(post), isAdmin: true, __proto__x: 1 }));
    const revived = revivePost(raw);
    expect(revived).toBeInstanceOf(Post);
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect('isAdmin' in revived).toBe(false);
    const comment = reviveComment({
      ...JSON.parse(JSON.stringify({ id: 'c1', postId: 'p', authorId: 'a', body: 'b' })),
      createdAt: '2026-01-01T00:00:00Z',
      roles: ['admin'],
    });
    expect('roles' in comment).toBe(false);
  });
});

describe('RolesGuard', () => {
  const ctx = (meta: Record<PropertyKey, unknown>, roles?: string[]) =>
    ({ meta, currentUser: roles && { id: 'u', name: 'U', roles } }) as never;

  test('reads @Roles() from ctx.meta and passes only a user holding one of them', () => {
    expect(RolesGuard(ctx({ [ROLES]: ['admin'] }, ['admin']))).toBe(true);
    expect(RolesGuard(ctx({ [ROLES]: ['admin'] }, []))).toBe(false);
    expect(RolesGuard(ctx({ [ROLES]: ['admin'] }))).toBe(false);
  });

  test('strict: without @Roles() metadata it denies', () => {
    expect(RolesGuard(ctx({}, ['admin']))).toBe(false);
    expect(RolesGuard(ctx({ [ROLES]: [] }, ['admin']))).toBe(false);
  });
});

describe('events crossing Redis', () => {
  const event = {
    id: 'p9',
    authorId: 'a2',
    title: 'T',
    body: '<p>ok</p><img src=x onerror=alert(1)><script>alert(2)</script>',
    status: 'PUBLISHED',
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    publishedAt: null,
  };

  test('revivePost and reviveComment sanitize the body again', () => {
    const post = revivePost(event as never);
    expect(post.body).toContain('<p>ok</p>');
    expect(post.body).not.toContain('onerror');
    expect(post.body).not.toContain('<script');
    const comment = reviveComment({ ...event, postId: 'p9' } as never);
    expect(comment.body).not.toContain('onerror');
  });

  test('an event with an unknown status is dropped by the filter (and revive throws)', () => {
    expect(isPostEvent(event)).toBe(true);
    expect(isPostEvent({ ...event, status: 'ARCHIVED' })).toBe(false);
    expect(isPostEvent(null)).toBe(false);
    expect(() => revivePost({ ...event, status: 'ARCHIVED' } as never)).toThrow('status');
    expect(isCommentEvent({ id: 'c', postId: 'p', body: 'b' })).toBe(true);
    expect(isCommentEvent({ id: 'c', postId: 7, body: 'b' })).toBe(false);
  });
});

describe('RedisPubSub configuration', () => {
  test('production refuses to start without REDIS_PUBSUB_SIGNING_KEY', () => {
    expect(() =>
      redisPubSubOptions({ NODE_ENV: 'production', REDIS_URL: 'rediss://cache' }),
    ).toThrow('REDIS_PUBSUB_SIGNING_KEY');
    expect(
      redisPubSubOptions({
        NODE_ENV: 'production',
        REDIS_URL: 'rediss://cache',
        REDIS_PUBSUB_SIGNING_KEY: 'k',
      }).signingKey,
    ).toBe('k');
  });

  test('REDIS_PUBSUB_SIGNING_KEY becomes the signingKey', () => {
    expect(redisPubSubOptions({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      url: 'redis://localhost:6379',
    });
    expect(
      redisPubSubOptions({ REDIS_URL: 'redis://localhost:6379', REDIS_PUBSUB_SIGNING_KEY: 'k' }),
    ).toEqual({ url: 'redis://localhost:6379', signingKey: 'k' });
    expect(redisPubSubOptions({ REDIS_PUBSUB_ENCRYPTION_KEY: 'e' })).toEqual({
      url: undefined,
      encryptionKey: 'e',
    });
  });
});
