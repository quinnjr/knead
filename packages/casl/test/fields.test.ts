import { afterEach, expect, test } from 'bun:test';
import type { AbilityBuilder, MongoAbility } from '@casl/ability';
import { Controller, Get, UseGuards } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import {
  AbilityGuard,
  Can,
  CaslModule,
  createAppAbility,
  definePermissions,
  fullGrant,
  PermittedFields,
  pickPermitted,
  SkipAbility,
} from '../src/index.js';
import { bearer, resolve, type TestUser } from './fixtures.js';

const permissions = definePermissions({
  users: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['id', 'name', 'email'] }] },
  },
  everything: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User' }] },
  },
  billing: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }] },
  },
});

function defineUserAbility(user: TestUser, { can }: AbilityBuilder<MongoAbility>): void {
  can('read', 'User', ['id', 'name']);
  can('read', 'User', { id: user.id });
  if (user.id === 'root') can('read', 'User');
}

const rows = () => [
  { id: 'alice', name: 'Alice', email: 'a@x', billingAddress: '1 Main' },
  { id: 'bob', name: 'Bob', email: 'b@x', billingAddress: '2 Main' },
];

class UserEntity {
  constructor(
    public id: string,
    public name: string,
    public billingAddress: string,
  ) {}
}

@Controller()
@UseGuards(AbilityGuard)
class UsersController {
  @Get('/users') @Can('read', 'User') @PermittedFields('User') list() {
    return rows();
  }

  @Get('/me') @Can('read', 'User') @PermittedFields('User') async me() {
    return rows()[0];
  }

  @Get('/mixed') @Can('read', 'User') @PermittedFields('User') mixed() {
    return [1, 'x', null, rows()[1]];
  }

  @Get('/response') @Can('read', 'User') @PermittedFields('User') response() {
    return new Response('raw', { status: 201 });
  }

  @Get('/none') @Can('read', 'User') @PermittedFields('User') none() {
    return undefined;
  }

  @Get('/null') @Can('read', 'User') @PermittedFields('User') nul() {
    return null;
  }

  @Get('/entity') @Can('read', 'User') @PermittedFields('User') entity() {
    return new UserEntity('bob', 'Bob', '2 Main');
  }

  @Get('/tojson') @Can('read', 'User') @PermittedFields('User') toJson() {
    return { toJSON: () => rows()[1] };
  }

  @Get('/nested') @Can('read', 'User') @PermittedFields('User') nested() {
    return [rows()];
  }

  @Get('/date') @Can('read', 'User') @PermittedFields('User') date() {
    return { id: 'alice', name: new Date(0) };
  }

  @Get('/bytes') @Can('read', 'User') @PermittedFields('User') bytes() {
    return new Uint8Array([1, 2, 3]);
  }

  @Get('/cycle') @Can('read', 'User') @PermittedFields('User') cycle() {
    const list: unknown[] = [rows()[0]];
    list.push(list);
    return list;
  }

  @Get('/selfjson') @Can('read', 'User') @PermittedFields('User') selfJson() {
    return {
      id: 'alice',
      toJSON() {
        return [this];
      },
    };
  }

  @Get('/jsonself') @Can('read', 'User') @PermittedFields('User') jsonSelf() {
    return {
      id: 'bob',
      billingAddress: '2 Main',
      toJSON() {
        return this;
      },
    };
  }

  @Get('/shared') @Can('read', 'User') @PermittedFields('User') shared() {
    const list = [rows()[1]];
    return [list, list];
  }

  @Get('/noguard') @SkipAbility() @PermittedFields('User') noguard() {
    return rows();
  }
}

let app: TestApp | undefined;
let mod: TestingModule | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(): Promise<TestApp> {
  mod = await Test.createModule({
    imports: [CaslModule.forRoot({ permissions, resolve, defineUserAbility })],
    controllers: [UsersController],
  }).compile();
  app = await mod.createApp();
  return app;
}

test('strips per record using conditions', async () => {
  const a = await serve();
  const res = await a.request('GET', '/users', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(200);
  const [self, other] = (await res.json()) as Record<string, unknown>[];
  expect(self).toEqual(rows()[0]!);
  expect(other).toEqual({ id: 'bob', name: 'Bob' });
});

test('grant narrows fields', async () => {
  const a = await serve();
  const res = await a.request('GET', '/me', bearer('alice', { users: 'read' }));
  expect(await res.json()).toEqual({ id: 'alice', name: 'Alice', email: 'a@x' });
});

test('non-object array items pass through', async () => {
  const a = await serve();
  const res = await a.request('GET', '/mixed', bearer('alice', fullGrant(permissions)));
  expect(await res.json()).toEqual([1, 'x', null, { id: 'bob', name: 'Bob' }]);
});

test('Response passes through', async () => {
  const a = await serve();
  const res = await a.request('GET', '/response', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(201);
  expect(await res.text()).toBe('raw');
});

test('undefined result is a 204', async () => {
  const a = await serve();
  const res = await a.request('GET', '/none', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(204);
});

test('null result passes through unchanged', async () => {
  const a = await serve();
  const res = await a.request('GET', '/null', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
});

test('without guard is a 403', async () => {
  const a = await serve();
  const res = await a.request('GET', '/noguard', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(403);
});

test('class instances are stripped', async () => {
  const a = await serve();
  const res = await a.request('GET', '/entity', bearer('alice', fullGrant(permissions)));
  expect(await res.json()).toEqual({ id: 'bob', name: 'Bob' });
});

test('toJSON results are stripped', async () => {
  const a = await serve();
  const res = await a.request('GET', '/tojson', bearer('alice', fullGrant(permissions)));
  expect(await res.json()).toEqual({ id: 'bob', name: 'Bob' });
});

test('nested arrays are stripped per record', async () => {
  const a = await serve();
  const res = await a.request('GET', '/nested', bearer('alice', fullGrant(permissions)));
  expect(await res.json()).toEqual([[rows()[0], { id: 'bob', name: 'Bob' }]]);
});

test('a Date value inside a permitted key survives', async () => {
  const a = await serve();
  const res = await a.request('GET', '/date', bearer('alice', fullGrant(permissions)));
  expect(await res.json()).toEqual({ id: 'alice', name: new Date(0).toISOString() });
});

test('binary results pass through', async () => {
  const a = await serve();
  const res = await a.request('GET', '/bytes', bearer('alice', fullGrant(permissions)));
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

test('a cyclic result is a 500, not a stack overflow', async () => {
  const a = await serve();
  const res = await a.request('GET', '/cycle', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain('a@x');
  const logged = mod!.logs.flatMap((e) => e.meta.map((m) => String((m as Error)?.message)));
  expect(logged.some((m) => m.includes('PermittedFields: the result contains a cycle'))).toBe(true);
});

test('a toJSON() returning an array that contains the record is a clear cycle error', async () => {
  const a = await serve();
  const res = await a.request('GET', '/selfjson', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(500);
  const logged = mod!.logs.flatMap((e) => e.meta.map((m) => String((m as Error)?.message)));
  expect(logged.some((m) => m.includes('PermittedFields: the result contains a cycle'))).toBe(true);
});

test('a toJSON() returning its own record is stripped, not a cycle', async () => {
  const a = await serve();
  const res = await a.request('GET', '/jsonself', bearer('alice', fullGrant(permissions)));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: 'bob' });
});

test('an array referenced twice (not a cycle) is stripped both times', async () => {
  const a = await serve();
  const res = await a.request('GET', '/shared', bearer('alice', fullGrant(permissions)));
  const bob = { id: 'bob', name: 'Bob' };
  expect(await res.json()).toEqual([[bob], [bob]]);
});

test('pickPermitted defines an own __proto__ key instead of setting the prototype', () => {
  const ability = createAppAbility([{ action: 'read', subject: 'User' }]);
  const out = pickPermitted(ability, 'User', JSON.parse('{"__proto__":{"x":1},"id":"u1"}'));
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  expect((out as { x?: number }).x).toBeUndefined();
  expect(Object.keys(out)).toEqual(['__proto__', 'id']);
});
