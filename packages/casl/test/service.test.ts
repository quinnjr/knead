import { afterEach, expect, test } from 'bun:test';
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Get, UnauthorizedException, UseGuards } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import {
  AbilityGuard,
  AbilityService,
  Can,
  CaslConfigError,
  CaslModule,
  type CaslModuleOptions,
} from '../src/index.js';
import { bearer, defineUserAbility, options, permissions, type TestUser } from './fixtures.js';

let app: TestApp | undefined;
const modules: TestingModule[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const m of modules.splice(0)) await m.close();
});

async function service(casl: CaslModuleOptions<TestUser>): Promise<AbilityService> {
  const mod = await Test.createModule({ imports: [CaslModule.forRoot(casl)] }).compile();
  modules.push(mod);
  return mod.get(AbilityService);
}

test('ability is built once per request', async () => {
  let builds = 0;
  @Controller()
  @UseGuards(AbilityGuard)
  class C {
    readonly #abilities = inject(AbilityService);
    @Get('/posts') @Can('read', 'Post') async list(ctx: Ctx) {
      await this.#abilities.authorize(ctx, 'read', 'Post');
      await this.#abilities.forCtx(ctx);
      return [];
    }
  }
  const mod = await Test.createModule({
    imports: [
      CaslModule.forRoot<TestUser>({
        ...options,
        defineUserAbility: (user, builder) => {
          builds++;
          defineUserAbility(user, builder);
        },
      }),
    ],
    controllers: [C],
  }).compile();
  app = await mod.createApp();
  const auth = bearer('alice', { posts: 'read' });
  expect((await app.request('GET', '/posts', auth)).status).toBe(200);
  expect(builds).toBe(1);
  expect((await app.request('GET', '/posts', auth)).status).toBe(200);
  expect(builds).toBe(2);
});

test('a rejected build is not cached', async () => {
  let calls = 0;
  const abilities = await service({
    ...options,
    defineUserAbility: (user, builder) => {
      calls++;
      if (calls === 1) throw new Error('transient');
      defineUserAbility(user, builder);
    },
  });
  const ctx = {
    req: new Request('http://x/', bearer('alice', { posts: 'read' })),
    state: {},
    meta: {},
  } as unknown as Ctx;
  await expect(abilities.forCtx(ctx)).rejects.toThrow('transient');
  expect((await abilities.forCtx(ctx)).can('read', 'Post')).toBe(true);
});

test('a spread copy of a ctx state (a WS operation of an upgrade) does not reuse its ability', async () => {
  let builds = 0;
  const abilities = await service({
    ...options,
    defineUserAbility: (user, builder) => {
      builds++;
      defineUserAbility(user, builder);
    },
  });
  const upgrade = {
    req: new Request('http://x/', bearer('alice', { posts: 'read' })),
    state: {},
    meta: {},
  } as unknown as Ctx;
  await abilities.forCtx(upgrade);
  expect(builds).toBe(1);
  // subscriptions.ts operationView: `{ ...http.state }` copies own symbol keys too.
  const operation = { ...upgrade, state: { ...upgrade.state } } as unknown as Ctx;
  expect(Object.getOwnPropertySymbols(operation.state).length).toBe(1);
  await abilities.forCtx(operation);
  expect(builds).toBe(2);
  await abilities.forCtx(operation);
  await abilities.forCtx(upgrade);
  expect(builds).toBe(2);
});

test('GraphQL subscription root fields rebuild instead of using the cache', async () => {
  let builds = 0;
  const abilities = await service({
    ...options,
    resolve: () => ({ user: { id: 'alice', roles: [] }, grant: { posts: 'read' } }),
    defineUserAbility: (user, builder) => {
      builds++;
      defineUserAbility(user, builder);
    },
  });
  const schema = { getSubscriptionType: () => ({ name: 'Subscription' }) };
  const gql = (parent: string) => ({
    state: {},
    meta: {},
    info: { fieldName: 'f', parentType: { name: parent }, schema },
  });
  const sub = gql('Subscription');
  await abilities.forCtx(sub);
  await abilities.forCtx(sub);
  expect(builds).toBe(2);
  const query = gql('Query');
  await abilities.forCtx(query);
  await abilities.forCtx(query);
  expect(builds).toBe(3);
});

test('validateGrant', async () => {
  const abilities = await service(options);
  const user: TestUser = { id: 'alice', roles: [] };
  expect(await abilities.validateGrant(user, { billing: 'read' })).toEqual({
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
  const write = await abilities.validateGrant(user, { posts: 'write' });
  expect(write.ok).toBe(true);
  expect(write.ok && { ...write.grant }).toEqual({ posts: 'write' });
  expect(await abilities.validateGrant(user, 'posts:admin')).toEqual({
    ok: false,
    problems: [{ reason: 'malformed' }],
  });
});

test('validateGrant checks the fields a grant names', async () => {
  const fieldUser = await service({
    ...options,
    defineUserAbility: (_user, { can }) => {
      can('read', 'User', ['id', 'name']);
    },
  });
  const user: TestUser = { id: 'alice', roles: [] };
  expect(await fieldUser.validateGrant(user, 'billing:read')).toEqual({
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
  const unrestricted = await service({
    ...options,
    defineUserAbility: (_user, { can }) => {
      can('read', 'User');
    },
  });
  const ok = await unrestricted.validateGrant(user, 'billing:read');
  expect(ok.ok).toBe(true);
});

test('validateGrant rejects a field the user is explicitly forbidden', async () => {
  const abilities = await service({
    ...options,
    defineUserAbility: (_user, { can, cannot }) => {
      can('read', 'User');
      cannot('read', 'User', ['billingAddress']);
    },
  });
  expect(await abilities.validateGrant({ id: 'alice', roles: [] }, 'billing:read')).toEqual({
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

test('a null identity is unauthenticated', async () => {
  const abilities = await service({ ...options, resolve: () => null });
  const ctx = { req: new Request('http://x/'), state: {}, meta: {} } as unknown as Ctx;
  await expect(abilities.forCtx(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
});

test('forRoot rejects bad options', () => {
  for (const key of ['resolve', 'defineUserAbility', 'permissions'] as const) {
    const bad = { ...options, [key]: undefined } as unknown as CaslModuleOptions;
    expect(() => CaslModule.forRoot(bad)).toThrow(CaslConfigError);
  }
  expect(() => CaslModule.forRoot(undefined as unknown as CaslModuleOptions)).toThrow(
    CaslConfigError,
  );
  expect(() =>
    CaslModule.forRoot({ ...options, permissions: {} as unknown as typeof permissions }),
  ).toThrow(CaslConfigError);
  const nullAreas = { ...permissions, areas: null } as unknown as typeof permissions;
  expect(() => CaslModule.forRoot({ ...options, permissions: nullAreas })).toThrow(CaslConfigError);
});
