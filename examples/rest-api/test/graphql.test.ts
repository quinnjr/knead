import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../src/app.module.js';

let mod: TestingModule;
let app: TestApp;
const admin = { authorization: 'Bearer admin-token' };
const create =
  'mutation($name: String!, $bio: String) { createUser(name: $name, bio: $bio) { id name bio } }';

beforeAll(async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  app = await mod.createApp();
});
afterAll(async () => {
  await mod.close();
});

describe('example GraphQL API', () => {
  test('queries go through the same middleware as REST', async () => {
    const res = await app.graphql('{ users { id name } }', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.data).toEqual({ users: [{ id: '1', name: 'Ada' }] });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('ratelimit-limit')).toBe('100');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('unknown users are NOT_FOUND', async () => {
    const res = await app.graphql('{ user(id: "404") { name } }');
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  test('createUser requires a token whose grant allows it', async () => {
    const anonymous = await app.graphql(create, { variables: { name: 'Eve' } });
    expect(anonymous.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    const reader = await app.graphql(create, {
      variables: { name: 'Eve' },
      headers: { authorization: 'Bearer user-token' },
    });
    expect(reader.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('createUser validates and sanitizes its arguments', async () => {
    const invalid = await app.graphql(create, { variables: { name: '   ' }, headers: admin });
    expect(invalid.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const res = await app.graphql(create, {
      variables: { name: ' Grace ', bio: '<b>hi</b><script>x</script>' },
      headers: admin,
    });
    expect(res.data?.createUser).toMatchObject({ name: 'Grace', bio: '<b>hi</b>' });
  });
});
