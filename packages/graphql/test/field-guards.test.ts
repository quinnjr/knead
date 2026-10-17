import { afterEach, describe, expect, test } from 'bun:test';
import { getMetadata, InjectionToken, inject, Module } from '@knead-js/core';
import { type Ctx, createRouteDecorator, HttpConfigError, ROUTE_META } from '@knead-js/http';
import type { GraphQLObjectType, GraphQLResolveInfo } from 'graphql';
import { OperationContext } from '../src/context.js';
import {
  FIELD_GUARDS,
  Field,
  GraphQLRuntime,
  Int,
  InterfaceType,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
  SchemaBuildError,
  UseFieldGuards,
} from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

type FieldCtx = ResolverCtx<{}, any>;

describe('UseFieldGuards', () => {
  test('guard sees parent and fieldName', async () => {
    const seen: [unknown, string][] = [];
    const g = (ctx: FieldCtx) => {
      seen.push([ctx.parent, ctx.info.fieldName]);
      return ctx.info.fieldName !== 'secret';
    };
    @ObjectType()
    @UseFieldGuards(g)
    class User {
      @Field(() => Int) id!: number;
      @Field(() => String, { nullable: true }) secret?: string | null;
    }
    const row = { id: 1, secret: 's3cret' };
    @Resolver(() => User)
    class Users {
      @Query(() => User) user() {
        return row;
      }
    }
    @Module({ providers: [Users] })
    class M {}
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ user { id secret } }');
    expect(res.data).toEqual({ user: { id: 1, secret: null } });
    expect(res.errors?.length).toBe(1);
    expect(res.errors?.[0]?.path).toEqual(['user', 'secret']);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(seen).toEqual([
      [row, 'id'],
      [row, 'secret'],
    ]);
  });

  test('applies to @ResolveField', async () => {
    let calls = 0;
    const g = (ctx: FieldCtx) => ctx.info.fieldName !== 'summary';
    @ObjectType()
    @UseFieldGuards(g)
    class Post {
      @Field(() => String) title!: string;
    }
    @Resolver(() => Post)
    class Posts {
      @Query(() => Post) post() {
        return { title: 't' };
      }
      @ResolveField(() => String, { nullable: true }) summary() {
        calls++;
        return 'sum';
      }
    }
    @Module({ providers: [Posts] })
    class M {}
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ post { title summary } }');
    expect(res.data).toEqual({ post: { title: 't', summary: null } });
    expect(res.errors?.[0]?.path).toEqual(['post', 'summary']);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(calls).toBe(0);
  });

  test('non-null field bubbles', async () => {
    const g = (ctx: FieldCtx) => ctx.info.fieldName !== 'secret';
    @ObjectType()
    @UseFieldGuards(g)
    class Account {
      @Field(() => Int) id!: number;
      @Field(() => String) secret!: string;
    }
    @Resolver(() => Account)
    class Accounts {
      @Query(() => Account, { nullable: true }) account() {
        return { id: 1, secret: 's' };
      }
    }
    @Module({ providers: [Accounts] })
    class M {}
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ account { id secret } }');
    expect(res.data).toEqual({ account: null });
    expect(res.errors?.[0]?.path).toEqual(['account', 'secret']);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('type meta reaches ctx.meta', async () => {
    const Tag = createRouteDecorator<string>('tag');
    const tags: unknown[] = [];
    const g = (ctx: FieldCtx) => {
      tags.push(ctx.meta.tag);
      return true;
    };
    @ObjectType()
    @Tag('x')
    @UseFieldGuards(g)
    class Tagged {
      @Field(() => Int) id!: number;
    }
    @Resolver(() => Tagged)
    class R {
      @Query(() => Tagged) tagged() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ tagged { id } }');
    expect(res.data).toEqual({ tagged: { id: 1 } });
    expect(tags).toEqual(['x']);
  });

  test('unguarded types untouched', async () => {
    let calls = 0;
    const g = () => {
      calls++;
      return true;
    };
    @ObjectType()
    @UseFieldGuards(g)
    class Guarded {
      @Field(() => Int) id!: number;
    }
    @ObjectType()
    class Plain {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Guarded) guarded() {
        return { id: 1 };
      }
      @Query(() => Plain) plain() {
        return { id: 2 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    const res = await s.app.graphql('{ plain { id } }');
    expect(res.data).toEqual({ plain: { id: 2 } });
    expect(calls).toBe(0);
    // No per-field cost: graphql-js uses its default resolver for an unguarded type.
    const schema = s.mod.get(GraphQLRuntime).schema;
    expect((schema.getType('Plain') as GraphQLObjectType).getFields().id?.resolve).toBeUndefined();
    expect((schema.getType('Guarded') as GraphQLObjectType).getFields().id?.resolve).toBeFunction();
  });

  test('invalid ref', async () => {
    @ObjectType()
    @UseFieldGuards(undefined as any)
    class Broken {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Broken) broken() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    const failure = await startGraphQL([M]).catch((e) => e);
    expect(failure).toBeInstanceOf(HttpConfigError);
    expect((failure as Error).message).toContain('the field guards of Broken');
  });

  test('a non-array FIELD_GUARDS value fails at bootstrap', async () => {
    const Corrupted = createRouteDecorator<unknown>(FIELD_GUARDS);
    @ObjectType()
    @Corrupted('nope')
    class Corrupt {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Corrupt) corrupt() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    const failure = await startGraphQL([M]).catch((e) => e);
    expect(failure).toBeInstanceOf(SchemaBuildError);
    expect((failure as Error).message).toContain('the field guards of Corrupt');
  });

  test('stacks', async () => {
    const calls: string[] = [];
    const guard = (name: string) => (ctx: FieldCtx) => {
      calls.push(`${name}:${ctx.info.parentType.name}.${ctx.info.fieldName}`);
      return true;
    };
    @ObjectType()
    @UseFieldGuards(guard('a'))
    @UseFieldGuards(guard('b'))
    class Base {
      @Field(() => Int) id!: number;
    }
    @ObjectType()
    @UseFieldGuards(guard('child'))
    class Sub extends Base {}
    @Resolver()
    class R {
      @Query(() => Base) base() {
        return { id: 1 };
      }
      @Query(() => Sub) sub() {
        return { id: 2 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    expect((await s.app.graphql('{ base { id } }')).data).toEqual({ base: { id: 1 } });
    expect(calls.sort()).toEqual(['a:Base.id', 'b:Base.id']);
    calls.length = 0;
    expect((await s.app.graphql('{ sub { id } }')).data).toEqual({ sub: { id: 2 } });
    expect(calls.sort()).toEqual(['a:Sub.id', 'b:Sub.id', 'child:Sub.id']);
    calls.length = 0;
    expect((await s.app.graphql('{ base { id } }')).data).toEqual({ base: { id: 1 } });
    expect(calls.sort()).toEqual(['a:Base.id', 'b:Base.id']);
  });

  test('writes the guard list under Symbol.for("knead:gql:field-guards")', () => {
    expect(FIELD_GUARDS === Symbol.for('knead:gql:field-guards')).toBe(true);
  });

  test('stores a frozen copy of the guard list', () => {
    const a = () => true;
    const b = () => true;
    @ObjectType()
    @UseFieldGuards(a)
    class Base {
      @Field(() => Int) id!: number;
    }
    @ObjectType()
    @UseFieldGuards(b)
    class Sub extends Base {}
    const base = getMetadata(Base, ROUTE_META)![FIELD_GUARDS];
    const sub = getMetadata(Sub, ROUTE_META)![FIELD_GUARDS];
    expect(base).toEqual([a]);
    expect(sub).toEqual([a, b]);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(sub)).toBe(true);
  });

  test('guards a concrete type reached through an interface field', async () => {
    @InterfaceType({ resolveType: () => 'Account' })
    class Node {
      @Field(() => Int) id!: number;
    }
    @ObjectType({ implements: () => [Node] })
    @UseFieldGuards((ctx: FieldCtx) => ctx.info.fieldName !== 'secret')
    class Account extends Node {
      @Field(() => String, { nullable: true }) secret?: string | null;
    }
    @Resolver()
    class R {
      @Query(() => Node, { nullable: true }) node() {
        return { id: 1, secret: 's3cret' };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M], { orphanedTypes: [Account] });
    const res = await s.app.graphql('{ node { id ... on Account { secret } } }');
    expect(res.data).toEqual({ node: { id: 1, secret: null } });
    expect(res.errors?.length).toBe(1);
    expect(res.errors?.[0]?.path).toEqual(['node', 'secret']);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  test('only === true passes, sync or async; a throwing guard is reported', async () => {
    let verdict: unknown = true;
    const g = () => verdict as boolean;
    @ObjectType()
    @UseFieldGuards(g)
    class V {
      @Field(() => Int, { nullable: true }) id?: number | null;
    }
    @Resolver()
    class R {
      @Query(() => V) v() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    for (const ok of [true, Promise.resolve(true)]) {
      verdict = ok;
      expect((await s.app.graphql('{ v { id } }')).data).toEqual({ v: { id: 1 } });
    }
    for (const bad of [1, 'yes', {}, false, Promise.resolve('yes'), Promise.resolve(false)]) {
      verdict = bad;
      const res = await s.app.graphql('{ v { id } }');
      expect(res.data).toEqual({ v: { id: null } });
      expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
    verdict = Promise.reject(new Error('boom'));
    (verdict as Promise<unknown>).catch(() => {});
    const rejected = await s.app.graphql('{ v { id } }');
    expect(rejected.data).toEqual({ v: { id: null } });
    expect(rejected.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('stays synchronous when every guard returns true synchronously', async () => {
    const sync = () => true;
    let second: unknown = true;
    @ObjectType()
    @UseFieldGuards(sync, () => second as boolean)
    class Fast {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Fast) fast() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M]);
    const type = s.mod.get(GraphQLRuntime).schema.getType('Fast') as GraphQLObjectType;
    const resolve = type.getFields().id!.resolve!;
    const op = new OperationContext({} as Ctx, {}, ['query']);
    const info = { fieldName: 'id' } as GraphQLResolveInfo;
    expect(resolve({ id: 7 }, {}, op, info)).toBe(7);
    second = Promise.resolve(true);
    const pending = resolve({ id: 8 }, {}, op, info);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(8);
  });

  test('class guards resolve from the root module injector', async () => {
    const ALLOW = new InjectionToken<boolean>('ALLOW');
    class Allow {
      readonly allow = inject(ALLOW);
      canActivate() {
        return this.allow;
      }
    }
    @ObjectType()
    @UseFieldGuards(Allow)
    class Secured {
      @Field(() => Int) id!: number;
    }
    @Resolver()
    class R {
      @Query(() => Secured) secured() {
        return { id: 1 };
      }
    }
    @Module({ providers: [R] })
    class M {}
    s = await startGraphQL([M], {}, [{ provide: ALLOW, useValue: true }]);
    expect((await s.app.graphql('{ secured { id } }')).data).toEqual({ secured: { id: 1 } });
  });
});
