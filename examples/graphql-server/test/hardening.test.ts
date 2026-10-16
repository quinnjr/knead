import { describe, expect, test } from 'bun:test';
import { AuthService, ROLES, RolesGuard } from '../src/auth/auth.js';
import { toCommentEvent, toPostEvent } from '../src/blog/blog.events.js';
import { Comment, Post, PostStatus, reviveComment, revivePost } from '../src/blog/blog.types.js';
import { listenOptions } from '../src/config.js';

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
