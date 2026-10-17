import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ForbiddenError } from '@casl/ability';
import {
  AbilityGuard,
  AbilityService,
  Can,
  CaslConfigError,
  CaslModule,
  type CaslModuleOptions,
  createAppAbility,
  definePermissions,
  MAX_SCOPE_LENGTH,
  mapCaslError,
  PermittedFields,
  parseGrant,
  pickPermitted,
  SkipAbility,
} from '@knead-js/casl';
import { KneadError } from '@knead-js/core';
import { PUBSUB, PubSub } from '@knead-js/graphql';
import { Controller, ForbiddenException, Get, UseGuards } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import { AppModule as RestModule } from '../snippets/casl/app.module.js';
import { AppModule as GlobalModule } from '../snippets/casl/global.module.js';
import { AppModule as GraphQLAppModule } from '../snippets/casl/graphql.module.js';
import {
  catalogForClients,
  everything,
  permissions,
  writeRules,
} from '../snippets/casl/permissions.js';
import { posts } from '../snippets/casl/posts.controller.js';
import { TokenIssuer } from '../snippets/casl/token-issuer.js';
import { ReportsController } from '../snippets/casl/typed-can.js';
import { defineUserAbility, sessions, type User } from '../snippets/casl/users.js';

const alice: User = { id: 'alice', name: 'Alice', admin: false };
const bob: User = { id: 'bob', name: 'Bob', admin: false };
const admin: User = { id: 'root', name: 'Root', admin: true };

beforeAll(() => {
  sessions.set('alice-read', { user: alice, grant: { posts: 'read' } });
  sessions.set('alice-write', { user: alice, grant: 'posts:write' });
  sessions.set('bob-write', { user: bob, grant: ['posts:write'] });
  sessions.set('admin-read', { user: admin, grant: { posts: 'read' } });
  sessions.set('admin-all', { user: admin, grant: everything });
  sessions.set('alice-users', { user: alice, grant: { users: 'read' } });
  sessions.set('alice-all', { user: alice, grant: everything });
  sessions.set('alice-none', { user: alice, grant: {} });
  sessions.set('alice-missing', { user: alice, grant: undefined });
  sessions.set('alice-malformed', { user: alice, grant: 'posts:admin' });
});
afterAll(() => sessions.clear());

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function start(module: Parameters<typeof Test.createModule>[0]): Promise<TestApp> {
  mod = await Test.createModule(module).compile({ development: false });
  return mod.createApp();
}

describe('casl: the catalog', () => {
  test('describe() and rulesFor() return what the guide shows', () => {
    expect(catalogForClients.areas[0]).toEqual({
      name: 'posts',
      description: 'Blog posts',
      levels: ['none', 'read', 'write', 'manage'],
    });
    expect(catalogForClients).toBe(permissions.describe());
    expect(Object.isFrozen(catalogForClients)).toBe(true);
    expect(writeRules).toEqual([
      { action: 'read', subject: 'Post' },
      { action: ['create', 'update'], subject: 'Post' },
    ]);
    expect(permissions.rulesFor('posts', 'none')).toEqual([]);
    expect(permissions.rulesFor('posts', 'admin')).toEqual([]);
    expect(everything).toEqual({ posts: 'manage', users: 'read', billing: 'read' });
  });

  test('invalid catalogs throw CaslConfigError, a KneadError', () => {
    const bad = (areas: unknown) => () =>
      definePermissions(areas as Parameters<typeof definePermissions>[0]);
    expect(bad({})).toThrow('permission catalog must define an area');
    expect(bad({ Posts: { levels: ['none', 'read'], rules: { read: [] } } })).toThrow(
      'area name "Posts" must match',
    );
    expect(bad({ posts: { levels: ['none', 'read'], rules: {} } })).toThrow(
      'area "posts": level "read" must add at least one rule',
    );
    expect(
      bad({
        posts: {
          levels: ['none', 'read'],
          rules: { read: [{ action: 'read', subject: 'Post', conditions: { a: 1 } }] },
        },
      }),
    ).toThrow('"conditions" is not supported (only action, subject and fields)');
    expect(
      bad({
        posts: {
          levels: ['none', 'read'],
          rules: { read: [{ action: 'read', subject: 'Post', fields: ['secret*'] }] },
        },
      }),
    ).toThrow('fields must not contain "*"');
    expect(bad({})).toThrow(CaslConfigError);
    expect(new CaslConfigError('x')).toBeInstanceOf(KneadError);
  });

  test('forRoot() validates its options at bootstrap', () => {
    const options = { permissions, resolve: () => undefined, defineUserAbility };
    expect(() =>
      CaslModule.forRoot({ ...options, resolve: undefined } as unknown as CaslModuleOptions),
    ).toThrow('CaslModule.forRoot(): resolve must be a function');
    expect(() =>
      CaslModule.forRoot({ ...options, permissions: {} } as unknown as CaslModuleOptions),
    ).toThrow('CaslModule.forRoot(): permissions must come from definePermissions()');
  });
});

describe('casl: grants', () => {
  test('object, scope string and array forms', () => {
    const expected = { posts: 'write', billing: 'read' };
    expect(parseGrant({ posts: 'write', billing: 'read' }, permissions)).toEqual(expected);
    expect(parseGrant('posts:write  billing:read', permissions)).toEqual(expected);
    expect(parseGrant(['posts:write', 'billing:read'], permissions)).toEqual(expected);
    const grant = parseGrant({ posts: 'read' }, permissions);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.getPrototypeOf(grant)).toBeNull();
  });

  test('empty is valid (and allows nothing), malformed is null', () => {
    for (const empty of [{}, '', []]) expect(parseGrant(empty, permissions)).toEqual({});
    expect(MAX_SCOPE_LENGTH).toBe(4096);
    for (const bad of [
      undefined,
      null,
      42,
      'posts:admin',
      'comments:read',
      'posts:read posts:write',
      'posts',
      { posts: 2 },
      'x'.repeat(MAX_SCOPE_LENGTH + 1),
      ['posts:read', 'users:read', 'billing:read', 'posts:write'],
    ]) {
      expect(parseGrant(bad, permissions)).toBeNull();
    }
    const proto = JSON.parse('{"__proto__":{"posts":"write"},"users":"read"}');
    expect(parseGrant(proto, permissions)).toEqual({ users: 'read' });
  });
});

describe('casl: REST', () => {
  test('no identity is a 401 problem', async () => {
    const app = await start({ imports: [RestModule] });
    const res = await app.request('GET', '/posts');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      instance: '/posts',
    });
  });

  test('a denial is a 403 problem', async () => {
    const app = await start({ imports: [RestModule] });
    const res = await app.request('PUT', '/posts/1', as('alice-read'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      instance: '/posts/1',
    });
  });

  test('the user and the grant must both allow', async () => {
    const app = await start({ imports: [RestModule] });
    expect((await app.request('GET', '/posts', as('alice-read'))).status).toBe(200);
    expect((await app.request('PUT', '/posts/1', as('alice-write'))).status).toBe(200);
    // bob has a write grant but the post is alice's: the user's condition still applies.
    expect((await app.request('PUT', '/posts/1', as('bob-write'))).status).toBe(403);
    // An admin is limited by the grant.
    expect((await app.request('PUT', '/posts/1', as('admin-read'))).status).toBe(403);
    expect((await app.request('PUT', '/posts/1', as('admin-all'))).status).toBe(200);
  });

  test('an empty, missing or malformed grant allows nothing', async () => {
    const app = await start({ imports: [RestModule] });
    for (const token of ['alice-none', 'alice-missing', 'alice-malformed']) {
      expect((await app.request('GET', '/posts', as(token))).status).toBe(403);
    }
  });

  test('@SkipAbility() needs no identity; a route without @Can() is denied', async () => {
    const app = await start({ imports: [RestModule] });
    expect((await app.request('GET', '/posts/count')).status).toBe(200);
    expect((await app.request('GET', '/posts/drafts', as('admin-all'))).status).toBe(403);
  });

  test('a CASL ForbiddenError is a 403 problem without its message', async () => {
    const app = await start({ imports: [RestModule] });
    const res = await app.request('POST', '/posts/1/publish', as('bob-write'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      instance: '/posts/1/publish',
    });
    const ok = await app.request('POST', '/posts/1/publish', as('alice-write'));
    expect(ok.status).toBe(200);
    posts.get('1')!.published = false;
  });

  test('createCan() writes the same meta as @Can()', async () => {
    const app = await start({ imports: [RestModule], controllers: [ReportsController] });
    expect((await app.request('GET', '/reports/posts', as('alice-read'))).status).toBe(200);
    expect((await app.request('GET', '/reports/posts', as('alice-none'))).status).toBe(403);
  });
});

describe('casl: field-level rules', () => {
  test('@PermittedFields() strips each record by the user and the grant', async () => {
    const app = await start({ imports: [RestModule] });
    const all = await app.request('GET', '/users', as('alice-all'));
    expect(await all.json()).toEqual([
      { id: 'alice', name: 'Alice', email: 'alice@example.com', billingAddress: '1 Main St' },
      { id: 'bob', name: 'Bob' },
    ]);
    const users = await app.request('GET', '/users', as('alice-users'));
    expect(await users.json()).toEqual([
      { id: 'alice', name: 'Alice', email: 'alice@example.com' },
      { id: 'bob', name: 'Bob' },
    ]);
  });

  test('an envelope is stripped as one record', async () => {
    const app = await start({ imports: [RestModule] });
    const res = await app.request('GET', '/users/page', as('admin-all'));
    expect(await res.json()).toEqual({});
  });

  test('@PermittedFields() without AbilityGuard is a 403', async () => {
    @Controller('/raw')
    class RawController {
      @Get('/')
      @PermittedFields('User')
      list() {
        return [];
      }
    }
    const app = await start({ imports: [RestModule], controllers: [RawController] });
    const res = await app.request('GET', '/raw', as('alice-all'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'PermittedFields requires AbilityGuard',
    );
  });

  test('pickPermitted() keeps the readable own keys', () => {
    const ability = createAppAbility([{ action: 'read', subject: 'User', fields: ['id'] }]);
    expect(pickPermitted(ability, 'User', { id: 'a', email: 'a@x' })).toEqual({ id: 'a' });
  });
});

describe('casl: issuing tokens', () => {
  test('validateGrant() rejects what exceeds the user', async () => {
    mod = await Test.createModule({
      imports: [RestModule],
      providers: [TokenIssuer],
    }).compile({ development: false });
    const abilities = mod.get(AbilityService);
    expect(await abilities.validateGrant(alice, 'posts:manage')).toEqual({
      ok: false,
      problems: [
        {
          reason: 'exceeds-user',
          area: 'posts',
          level: 'manage',
          action: 'delete',
          subject: 'Post',
        },
      ],
    });
    // Conditions are not evaluated at issue time: alice may read her own billingAddress.
    expect((await abilities.validateGrant(alice, 'billing:read')).ok).toBe(true);
    expect(await abilities.validateGrant(alice, 'posts:nope')).toEqual({
      ok: false,
      problems: [{ reason: 'malformed' }],
    });
    const issuer = mod.get(TokenIssuer);
    expect({ ...(await issuer.grantFor(alice, 'posts:write')) }).toEqual({ posts: 'write' });
    expect({ ...(await issuer.grantFor(admin, everything)) }).toEqual(everything);
    const error = await issuer.grantFor(alice, everything).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { status: number }).status).toBe(400);
  });
});

test('casl: validateGrant() names a field the user may not read', async () => {
  mod = await Test.createModule({
    imports: [
      CaslModule.forRoot<User>({
        permissions,
        resolve: () => undefined,
        defineUserAbility: (_user, { can }) => {
          can('read', 'User', ['id', 'name']);
        },
      }),
    ],
  }).compile({ development: false });
  expect(await mod.get(AbilityService).validateGrant(alice, { billing: 'read' })).toEqual({
    ok: false,
    problems: [
      {
        reason: 'exceeds-user',
        area: 'billing',
        level: 'read',
        action: 'read',
        subject: 'User',
        field: 'billingAddress',
      },
    ],
  });
});

/** Sends a raw WebSocket upgrade request and returns the response status code. */
function upgradeStatus(app: TestApp, path: string, token?: string): Promise<number> {
  const port = Number(app.url.port);
  return new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(sock) {
          sock.write(
            [
              `GET ${path} HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              ...(token === undefined ? [] : [`Authorization: Bearer ${token}`]),
              '',
              '',
            ].join('\r\n'),
          );
        },
        data(sock, chunk) {
          buf += chunk.toString();
          if (buf.includes('\r\n')) {
            resolve(Number(buf.split(' ')[1]));
            sock.end();
          }
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

describe('casl: a global AbilityGuard', () => {
  test('every route needs @Can() or @SkipAbility()', async () => {
    const app = await start({ imports: [GlobalModule] });
    expect((await app.request('GET', '/health')).status).toBe(200);
    expect((await app.request('GET', '/me')).status).toBe(401);
    expect((await app.request('GET', '/me', as('alice-users'))).status).toBe(200);
    expect((await app.request('GET', '/internal', as('admin-all'))).status).toBe(403);
  });

  test('WebSocket endpoints use canMeta() and skipAbilityMeta()', async () => {
    const app = await start({ imports: [GlobalModule] });
    expect(await upgradeStatus(app, '/feed', 'alice-read')).toBe(101);
    expect(await upgradeStatus(app, '/feed', 'alice-none')).toBe(403);
    expect(await upgradeStatus(app, '/feed')).toBe(401);
    expect(await upgradeStatus(app, '/status')).toBe(101);
    expect(await upgradeStatus(app, '/admin-feed', 'admin-all')).toBe(403);
  });
});

describe('casl: GraphQL', () => {
  test('fields are checked per record against the user and the grant', async () => {
    const app = await start({ imports: [GraphQLAppModule] });
    const res = await app.graphql('{ users { id email } }', as('alice-users'));
    expect(res.data).toEqual({
      users: [
        { id: 'alice', email: 'alice@example.com' },
        { id: 'bob', email: null },
      ],
    });
    expect(res.errors).toEqual([
      {
        message: 'Forbidden',
        locations: [{ line: 1, column: 14 }],
        path: ['users', 1, 'email'],
        extensions: { code: 'FORBIDDEN' },
      },
    ]);
  });

  test('no identity on a root field is UNAUTHENTICATED', async () => {
    const app = await start({ imports: [GraphQLAppModule] });
    const res = await app.graphql('{ users { id } }');
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  test('anonymous access to an @AbilitySubject type is UNAUTHENTICATED per field', async () => {
    const app = await start({ imports: [GraphQLAppModule] });
    const res = await app.graphql('{ featuredUser { name email } }');
    expect(res.data).toEqual({ featuredUser: { name: null, email: null } });
    expect(res.errors?.every((e) => e.extensions?.code === 'UNAUTHENTICATED')).toBe(true);
    expect(res.errors).toHaveLength(2);
  });

  test('a recheckGuards subscription rebuilds the ability for every event', async () => {
    sessions.set('alice-live', { user: alice, grant: { posts: 'read' } });
    const app = await start({ imports: [GraphQLAppModule] });
    const pubsub = mod!.get(PUBSUB);
    if (!(pubsub instanceof PubSub)) throw new Error('expected the in-memory PubSub');
    const sub = await app.graphqlSubscribe('subscription { postCount }', as('alice-live'));
    const deadline = Date.now() + 2000;
    while (pubsub.getSubscriberCount('post-count') === 0 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    await pubsub.publish('post-count', 1);
    expect((await sub.next()).value).toEqual({ data: { postCount: 1 } });
    // Narrow the token's grant: the next event is checked against the new one.
    sessions.set('alice-live', { user: alice, grant: {} });
    await pubsub.publish('post-count', 2);
    expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await sub.next()).done).toBe(true);
    await sub.close();
  });

  test('mapCaslError maps only CASL ForbiddenErrors', () => {
    const casl = ForbiddenError.from(createAppAbility([])).setMessage('secret');
    const mapped = mapCaslError(casl);
    expect(mapped).toBeInstanceOf(ForbiddenException);
    expect(mapped?.detail).toBeUndefined();
    expect(mapCaslError(new Error('x'))).toBeUndefined();
  });
});

describe('casl: guard edge cases', () => {
  test('@SkipAbility() on the class wins over @Can() on a method', async () => {
    @Controller('/public')
    @UseGuards(AbilityGuard)
    @SkipAbility()
    class PublicController {
      @Get('/')
      @Can('update', 'Post')
      index() {
        return 'ok';
      }
    }
    const app = await start({ imports: [RestModule], controllers: [PublicController] });
    expect((await app.request('GET', '/public')).status).toBe(200);
  });
});
