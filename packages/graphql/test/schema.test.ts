import { afterEach, describe, expect, test } from 'bun:test';
import { Injectable, Module } from '@knead-js/core';
import { Test } from '@knead-js/testing';
import { GraphQLScalarType } from 'graphql';
import {
  ArgsType,
  defineScalar,
  defineUnion,
  Field,
  GraphQLModule,
  ID,
  InputType,
  Int,
  InterfaceType,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  SchemaBuildError,
} from '../src/index.js';
import { BlogModule } from './fixtures/blog.js';
import { type Started, sdlOf, startGraphQL } from './helpers.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

async function bootError(providers: Function[], orphanedTypes: Function[] = []): Promise<Error> {
  @Module({ providers: providers as never })
  class M {}
  const result = await Test.createModule({
    imports: [GraphQLModule.forRoot({ orphanedTypes: orphanedTypes as never }), M],
  })
    .compile({ development: false })
    .then(
      () => undefined,
      (error: Error) => error,
    );
  if (!result) throw new Error('expected bootstrap to fail');
  return result;
}

describe('schema build', () => {
  test('blog fixture: objects, interface, union, enum, input, args class, list nullability', async () => {
    const sdl = await sdlOf([BlogModule]);
    expect(sdl).toContain('interface Node {\n  id: ID!\n}');
    expect(sdl).toContain('type User implements Node {');
    expect(sdl).toContain('  bio: String\n');
    expect(sdl).toContain('  posts: [Post!]!\n');
    expect(sdl).toContain('union SearchResult = Post | User');
    expect(sdl).toContain('"""What a user may do"""\nenum Role {\n  ADMIN\n  READER\n}');
    expect(sdl).toContain('input CreatePostInput {\n  tags: [String!]\n  title: String!\n}');
    expect(sdl).toContain('posts(after: ID, first: Int! = 10): [Post!]!');
    expect(sdl).toContain('post(id: ID!): Post\n');
    expect(sdl).toContain('author: User!');
  });

  test('nullable list levels', async () => {
    @ObjectType()
    class Lists {
      @Field(() => [String], { nullable: 'items' }) a!: (string | null | undefined)[];
      @Field(() => [String], { nullable: 'list' }) b?: string[] | null;
      @Field(() => [String], { nullable: 'both' }) c?: (string | null | undefined)[] | null;
    }
    @Resolver()
    class R {
      @Query(() => Lists) lists() {
        return new Lists();
      }
    }
    @Module({ providers: [R] })
    class M {}
    const sdl = await sdlOf([M]);
    expect(sdl).toContain('a: [String]!\n  b: [String!]\n  c: [String]\n');
  });

  test('a subclass inherits fields and may override one', async () => {
    @ObjectType()
    class Base {
      @Field(() => String) name!: string;
      @Field(() => Int) size!: number;
    }
    @ObjectType()
    class Child extends Base {
      @Field(() => String, { description: 'Overridden' }) override name = '';
    }
    @Resolver()
    class R {
      @Query(() => Child) child() {
        return new Child();
      }
    }
    @Module({ providers: [R] })
    class M {}
    const sdl = await sdlOf([M]);
    expect(sdl).toContain('type Child {\n  """Overridden"""\n  name: String!\n  size: Int!\n}');
  });

  test('custom scalars via defineScalar', async () => {
    const DateTime = defineScalar<Date>(
      new GraphQLScalarType<Date, string>({
        name: 'DateTime',
        serialize: (v) => (v as Date).toISOString(),
      }),
    );
    @Resolver()
    class R {
      @Query(() => DateTime) now() {
        return new Date(0);
      }
    }
    @Module({ providers: [R] })
    class M {}
    expect(await sdlOf([M])).toContain('scalar DateTime');
  });

  test('a thunk returning undefined names the class, field and likely missing import', async () => {
    let Missing: any;
    @ObjectType()
    class User {
      @Field(() => Missing) posts!: unknown;
    }
    @Resolver()
    class R {
      @Query(() => User) me() {
        return new User();
      }
    }
    const error = await bootError([R]);
    expect(error).toBeInstanceOf(SchemaBuildError);
    expect(error.message).toBe('User.posts: type thunk returned undefined — is Missing imported?');
  });

  test('duplicate type names across classes name both classes', async () => {
    @ObjectType({ name: 'Thing' })
    class A {
      @Field(() => ID) id!: string;
    }
    @ObjectType({ name: 'Thing' })
    class B {
      @Field(() => ID) id!: string;
    }
    @Resolver()
    class R {
      @Query(() => A) a() {
        return new A();
      }
      @Query(() => B) b() {
        return new B();
      }
    }
    const error = await bootError([R]);
    expect(error.message).toBe('Duplicate GraphQL type name "Thing": A and B.');
  });

  test('duplicate root fields name both resolvers', async () => {
    @Resolver()
    class R1 {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Resolver()
    class R2 {
      @Query(() => Int) n() {
        return 2;
      }
    }
    const error = await bootError([R1, R2]);
    expect(error.message).toBe('Duplicate Query field "n": R1.n and R2.n.');
  });

  test('undecorated classes and kind mismatches are explained', async () => {
    class Plain {}
    @InputType()
    class In {
      @Field(() => String) x!: string;
    }
    @ObjectType()
    class Out {
      @Field(() => String) x!: string;
    }
    @Resolver()
    class R1 {
      @Query(() => Plain) plain() {
        return new Plain();
      }
    }
    @Resolver()
    class R2 {
      @Query(() => In) input() {
        return new In();
      }
    }
    @Resolver()
    class R3 {
      @Query(() => Int, { args: { o: Out } }) arg() {
        return 1;
      }
    }
    expect((await bootError([R1])).message).toBe(
      'Query.plain: Plain is not decorated with @ObjectType() or @InterfaceType().',
    );
    expect((await bootError([R2])).message).toBe(
      'Query.input: In is an @InputType() and cannot be used as an output type.',
    );
    expect((await bootError([R3])).message).toBe(
      'Query.arg(o): Out is not an @InputType() and cannot be used as an input type.',
    );
  });

  test('@ArgsType cannot be combined with inline arguments', async () => {
    @ArgsType()
    class Paging {
      @Field(() => Int) first!: number;
    }
    @Resolver()
    class R {
      @Query(() => Int, { args: { paging: Paging } as never }) n() {
        return 1;
      }
    }
    expect((await bootError([R])).message).toContain(
      'Query.n(paging): @ArgsType() Paging cannot be used as an argument type; pass it as `args: Paging`',
    );
  });

  test('validate keys must match declared arguments', async () => {
    @Resolver()
    class R {
      @Query(() => Int, {
        args: { a: Int },
        validate: {
          b: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } },
        },
      })
      n() {
        return 1;
      }
    }
    expect((await bootError([R])).message).toBe(
      'R.n: validate.b does not match a declared argument.',
    );
  });

  test('@ResolveField needs a resolver type', async () => {
    @Resolver()
    class R {
      @Query(() => Int) n() {
        return 1;
      }
      @ResolveField(() => Int) extra() {
        return 1;
      }
    }
    expect((await bootError([R])).message).toBe(
      'R.extra: @ResolveField() requires @Resolver(() => Type) on R.',
    );
  });

  test('a schema without queries is rejected', async () => {
    expect((await bootError([])).message).toContain('No @Query() resolvers found');
  });

  test('orphaned types are included', async () => {
    @ObjectType()
    class Extra {
      @Field(() => Int) n!: number;
    }
    @Resolver()
    class R {
      @Query(() => Int) n() {
        return 1;
      }
    }
    @Module({ providers: [R] })
    class M {}
    expect(await sdlOf([M], { orphanedTypes: [Extra] })).toContain('type Extra {');
  });

  test('graphql-js validation errors are reported together', async () => {
    @ObjectType()
    class Empty {}
    @Resolver()
    class R {
      @Query(() => Empty) e() {
        return new Empty();
      }
    }
    expect((await bootError([R])).message).toContain(
      'Invalid GraphQL schema:\n  - Type Empty must define one or more fields.',
    );
  });
});

describe('default resolveType', () => {
  test('an interface field resolves class instances, subclasses included, without rescanning', async () => {
    let implementsCalls = 0;
    @InterfaceType()
    class Animal {
      @Field(() => String) name!: string;
    }
    @Injectable()
    @ObjectType({
      implements: () => {
        implementsCalls++;
        return [Animal];
      },
    })
    class Dog extends Animal {
      @Field(() => Int) barks!: number;
    }
    @ObjectType({ implements: () => [Animal] })
    class Puppy extends Dog {
      @Field(() => Int) age!: number;
    }
    /** Not an @ObjectType of its own: resolves as its nearest decorated ancestor, Dog. */
    class Corgi extends Dog {}
    const make = <T extends Animal>(cls: new () => T, fields: Partial<T>): T =>
      Object.assign(new cls(), fields);
    let count = 1;
    @Resolver()
    class Zoo {
      @Query(() => [Animal]) animals() {
        return Array.from({ length: count }, (_, i) =>
          i % 3 === 0
            ? make(Dog, { name: `d${i}`, barks: i })
            : i % 3 === 1
              ? make(Puppy, { name: `p${i}`, barks: i, age: 1 })
              : make(Corgi, { name: `c${i}`, barks: i }),
        );
      }
    }
    @Module({ providers: [Zoo] })
    class ZooModule {}
    s = await startGraphQL([ZooModule], { orphanedTypes: [Dog, Puppy] });
    const query = '{ animals { __typename name ... on Puppy { age } } }';
    count = 3;
    expect((await s.app.graphql(query)).data).toEqual({
      animals: [
        { __typename: 'Dog', name: 'd0' },
        { __typename: 'Puppy', name: 'p1', age: 1 },
        { __typename: 'Dog', name: 'c2' },
      ],
    });
    const before = implementsCalls;
    count = 60;
    const res = await s.app.graphql(query);
    expect(res.errors).toBeUndefined();
    expect((res.data as { animals: unknown[] }).animals).toHaveLength(60);
    // The implementations are computed once, not once per resolved value.
    expect(implementsCalls).toBe(before);
  });

  test('a union resolves its members without calling types() per value', async () => {
    @ObjectType()
    class Cat {
      @Field(() => String) meow!: string;
    }
    @ObjectType()
    class Cow {
      @Field(() => String) moo!: string;
    }
    let typesCalls = 0;
    const Pet = defineUnion({
      name: 'Pet',
      types: () => {
        typesCalls++;
        return [Cat, Cow];
      },
    });
    let count = 2;
    @Resolver()
    class Pets {
      @Query(() => [Pet]) pets() {
        return Array.from({ length: count }, (_, i) =>
          i % 2 === 0
            ? Object.assign(new Cat(), { meow: 'm' })
            : Object.assign(new Cow(), { moo: 'o' }),
        );
      }
    }
    @Module({ providers: [Pets] })
    class PetModule {}
    s = await startGraphQL([PetModule]);
    const query = '{ pets { __typename } }';
    expect((await s.app.graphql(query)).data).toEqual({
      pets: [{ __typename: 'Cat' }, { __typename: 'Cow' }],
    });
    const before = typesCalls;
    count = 60;
    expect((await s.app.graphql(query)).errors).toBeUndefined();
    expect(typesCalls).toBe(before);
  });
});
