import { afterEach, describe, expect, test } from 'bun:test';
import { type AbilityBuilder, ForbiddenError, type MongoAbility } from '@casl/ability';
import { getMetadata, Module, type ModuleImport } from '@knead-js/core';
import {
  FIELD_GUARDS,
  Field,
  GraphQLModule,
  type GraphQLModuleOptions,
  Int,
  ObjectType,
  PUBSUB,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
  UseFieldGuards,
} from '@knead-js/graphql';
import { ROUTE_META } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import {
  AbilityGuard,
  AbilitySubject,
  Can,
  CaslModule,
  createAppAbility,
  definePermissions,
  FieldAbilityGuard,
  type Identity,
  mapCaslError,
} from '../src/index.js';
import { bearer, resolve as restIdentity, type TestUser } from './fixtures.js';

const permissions = definePermissions({
  posts: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'Post' }] },
  },
  users: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['id', 'name', 'email'] }] },
  },
  billing: {
    levels: ['none', 'read'],
    rules: { read: [{ action: 'read', subject: 'User', fields: ['billingAddress'] }] },
  },
});

let builds = 0;
function defineUserAbility(user: TestUser, { can }: AbilityBuilder<MongoAbility>): void {
  builds++;
  can('read', 'Post');
  can('read', 'User', ['id', 'name']);
  can('read', 'User', ['email', 'billingAddress'], { id: user.id });
}

interface Row {
  id: string;
  name: string;
  email: string;
  billingAddress: string;
}
const row = (id: string): Row => ({
  id,
  name: `name-${id}`,
  email: `${id}@example.com`,
  billingAddress: `${id} street`,
});

const otherGuardSaw: string[] = [];
const OtherGuard = (ctx: ResolverCtx<{}, any>) => {
  otherGuardSaw.push(ctx.info.fieldName);
  return ctx.info.fieldName !== 'name';
};

@ObjectType()
@AbilitySubject('User')
class User {
  @Field(() => String) id!: string;
  @Field(() => String, { nullable: true }) name?: string | null;
  @Field(() => String, { nullable: true }) email?: string | null;
  @Field(() => String, { nullable: true }) billingAddress?: string | null;
}

@ObjectType()
@UseFieldGuards(OtherGuard)
@AbilitySubject('User')
class GuardedUser {
  @Field(() => String) id!: string;
  @Field(() => String, { nullable: true }) name?: string | null;
  @Field(() => String, { nullable: true }) email?: string | null;
}

@Resolver()
class Users {
  @Query(() => User) @Can('read', 'User') me(ctx: ResolverCtx) {
    return row((ctx as unknown as { currentUser: Identity<TestUser> }).currentUser.user.id);
  }
  @Query(() => [User]) @Can('read', 'User') users() {
    return [row('alice'), row('bob'), row('carol')];
  }
  @Query(() => GuardedUser) @Can('read', 'User') guarded() {
    return row('bob');
  }
  @Query(() => Int) undeclared() {
    return 1;
  }
  @Query(() => Int) @Can('read', 'Post') boom(): number {
    throw ForbiddenError.from(createAppAbility([])).setMessage('nope');
  }
  @Subscription(() => Int, { topic: 'posts', recheckGuards: true })
  @Can('read', 'Post')
  posts() {}
}

@Module({ providers: [Users] })
class UsersModule {}

let liveGrant: unknown;

function gqlOptions(): GraphQLModuleOptions {
  return {
    context: (http) => ({ currentUser: restIdentity(http) }),
    guards: [AbilityGuard],
    mapError: mapCaslError,
    subscriptions: {
      refreshContext: ({ context }) => {
        const current = context.currentUser as Identity<TestUser>;
        return { currentUser: { user: current.user, grant: liveGrant } } as never;
      },
    },
  };
}

let mod: TestingModule | undefined;
let app: TestApp | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
  app = undefined;
  builds = 0;
  otherGuardSaw.length = 0;
});

async function start(imports: ModuleImport[] = [UsersModule]): Promise<TestApp> {
  mod = await Test.createModule({
    imports: [
      GraphQLModule.forRoot(gqlOptions()),
      CaslModule.forRoot<TestUser>({
        permissions,
        defineUserAbility,
        resolve: (ctx) =>
          'info' in ctx
            ? (ctx as unknown as { currentUser?: Identity<TestUser> }).currentUser
            : restIdentity(ctx),
      }),
      ...imports,
    ],
  }).compile({ development: false });
  app = await mod.createApp();
  return app;
}

const all = { posts: 'read', users: 'read', billing: 'read' };

describe('@knead-js/casl on GraphQL', () => {
  test('root field requires @Can', async () => {
    const a = await start();
    const denied = await a.graphql('{ undeclared }', bearer('alice', all));
    expect(denied.data).toBeNull();
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const ok = await a.graphql('{ me { id } }', bearer('alice', all));
    expect(ok.data).toEqual({ me: { id: 'alice' } });
    expect(ok.errors).toBeUndefined();
  });

  test('strips fields on GraphQL', async () => {
    const a = await start();
    const res = await a.graphql(
      '{ me { id name email billingAddress } }',
      bearer('alice', { users: 'read' }),
    );
    expect(res.data).toEqual({
      me: { id: 'alice', name: 'name-alice', email: 'alice@example.com', billingAddress: null },
    });
    expect(res.errors?.length).toBe(1);
    expect(res.errors?.[0]?.path).toEqual(['me', 'billingAddress']);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const full = await a.graphql('{ me { billingAddress } }', bearer('alice', all));
    expect(full.data).toEqual({ me: { billingAddress: 'alice street' } });
  });

  test('per-record conditions', async () => {
    const a = await start();
    const res = await a.graphql('{ users { id email } }', bearer('alice', all));
    expect(res.data).toEqual({
      users: [
        { id: 'alice', email: 'alice@example.com' },
        { id: 'bob', email: null },
        { id: 'carol', email: null },
      ],
    });
    expect(res.errors?.map((e) => e.path)).toEqual([
      ['users', 1, 'email'],
      ['users', 2, 'email'],
    ]);
    expect(res.errors?.every((e) => e.extensions?.code === 'FORBIDDEN')).toBe(true);
  });

  test('raw ForbiddenError in resolver → FORBIDDEN', async () => {
    const a = await start();
    const res = await a.graphql('{ boom }', bearer('alice', all));
    expect(res.errors?.[0]).toMatchObject({ message: 'nope', extensions: { code: 'FORBIDDEN' } });
  });

  test('shared key', async () => {
    expect(FIELD_GUARDS === Symbol.for('knead:gql:field-guards')).toBe(true);
    const a = await start();
    const res = await a.graphql('{ guarded { id name email } }', bearer('alice', all));
    // OtherGuard denies `name`; FieldAbilityGuard denies bob's `email` (readable only on self).
    expect(res.data).toEqual({ guarded: { id: 'bob', name: null, email: null } });
    expect(res.errors?.map((e) => e.path?.join('.')).sort()).toEqual([
      'guarded.email',
      'guarded.name',
    ]);
    expect(otherGuardSaw).toContain('name');
    expect(otherGuardSaw).not.toContain('email');
  });

  test('one ability per operation', async () => {
    const a = await start();
    const res = await a.graphql('{ users { id name email } }', bearer('alice', all));
    expect(res.data?.users).toHaveLength(3);
    expect(builds).toBe(1);
  });

  test('subscription recheck rebuilds ability', async () => {
    const a = await start();
    liveGrant = { posts: 'read' };
    const pubsub = mod!.get(PUBSUB);
    const sub = await a.graphqlSubscribe('subscription { posts }', bearer('alice', liveGrant));
    await Bun.sleep(30);
    await pubsub.publish('posts', 1);
    expect((await sub.next()).value).toEqual({ data: { posts: 1 } });
    liveGrant = {};
    await pubsub.publish('posts', 2);
    expect((await sub.next()).value?.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await sub.next()).done).toBe(true);
    await sub.close();
  });
});

describe('AbilitySubject metadata', () => {
  test('never mutates the inherited route meta or guard list', () => {
    @ObjectType()
    @AbilitySubject('User')
    class Base {
      @Field(() => String) id!: string;
    }
    @ObjectType()
    @AbilitySubject('Admin')
    class Derived extends Base {}
    const baseMeta = getMetadata(Base, ROUTE_META)!;
    const derivedMeta = getMetadata(Derived, ROUTE_META)!;
    expect(baseMeta[FIELD_GUARDS]).toEqual([FieldAbilityGuard]);
    expect(Object.isFrozen(baseMeta[FIELD_GUARDS])).toBe(true);
    expect(baseMeta[Symbol.for('knead:casl:subject')]).toBe('User');
    expect(derivedMeta).not.toBe(baseMeta);
    expect(derivedMeta[FIELD_GUARDS]).toEqual([FieldAbilityGuard, FieldAbilityGuard]);
    expect(derivedMeta[Symbol.for('knead:casl:subject')]).toBe('Admin');
  });
});
