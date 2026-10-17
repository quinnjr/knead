import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AbilityService } from '@knead-js/casl';
import { ada, grace, type Started, start } from './helpers.js';

let s: Started;
beforeAll(async () => {
  s = await start();
});
afterAll(async () => {
  await s.mod.close();
});

const reader = { authorization: 'Bearer grace-reader-token' };
const me = '{ me { id name roles } }';

describe('abilities', () => {
  test('me needs a token', async () => {
    const res = await s.app.graphql(me);
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  test('@AbilitySubject: each Account field needs read on that field', async () => {
    const full = await s.app.graphql(me, { headers: ada });
    expect(full.errors).toBeUndefined();
    expect(full.data).toEqual({ me: { id: 'a1', name: 'Ada Lovelace', roles: ['admin'] } });
    // grace-token is granted account:profile, which does not cover `roles`.
    const profile = await s.app.graphql(me, { headers: grace });
    expect(profile.data).toEqual({ me: { id: 'a2', name: 'Grace Hopper', roles: null } });
    expect(profile.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(profile.errors?.[0]?.path).toEqual(['me', 'roles']);
  });

  test('a read-only token cannot write, even for its own posts', async () => {
    const res = await s.app.graphql(
      'mutation { createPost(input: { title: "Read only", body: "hi" }) { id } }',
      { headers: reader },
    );
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('validateGrant: a token cannot be issued beyond the user', async () => {
    const abilities = s.mod.get(AbilityService);
    const grant = 'blog:admin account:full';
    expect(
      await abilities.validateGrant({ id: 'a1', name: 'Ada', roles: ['admin'] }, grant),
    ).toMatchObject({ ok: true });
    const result = await abilities.validateGrant({ id: 'a2', name: 'Grace', roles: [] }, grant);
    expect(result).toEqual({
      ok: false,
      problems: [
        { reason: 'exceeds-user', area: 'blog', level: 'admin', action: 'delete', subject: 'Post' },
      ],
    });
  });
});
