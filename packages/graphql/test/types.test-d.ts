// Type-level tests: checked by `pnpm typecheck`, never executed.

import { GraphQLScalarType } from 'graphql';
import {
  ArgsType,
  defineEnum,
  defineScalar,
  defineUnion,
  Field,
  Float,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
  Subscription,
  type TsOf,
} from '../src/index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => {};

enum Role {
  ADMIN = 'ADMIN',
}
const RoleType = defineEnum(Role, { name: 'Role' });
const Color = defineEnum({ RED: 'red', BLUE: 'blue' } as const, { name: 'Color' });
const DateTime = defineScalar<Date>(new GraphQLScalarType({ name: 'DateTime' }));

@ObjectType()
class Post {
  @Field(() => ID) id!: string;
}

@ObjectType()
class User {
  @Field(() => ID) id!: string;
  @Field(() => String) name!: string;
  @Field(() => Int) age!: number;
  @Field(() => Float) score!: number;
  @Field(() => Boolean) admin!: boolean;
  @Field(() => RoleType) role!: Role;
  @Field(() => Color) color!: 'red' | 'blue';
  @Field(() => DateTime) createdAt!: Date;
  @Field(() => String, { nullable: true }) bio?: string | null;
  @Field(() => [Post]) posts!: Post[];
  @Field(() => [Post]) frozen!: readonly Post[];
  @Field(() => [String], { nullable: 'items' }) tags!: (string | null | undefined)[];
  @Field(() => [String], { nullable: 'list' }) aliases?: string[] | null;
  @Field(() => [String], { nullable: 'both' }) notes?: (string | null | undefined)[] | null;

  // @ts-expect-error GraphQL Int vs TS string
  @Field(() => Int) wrongScalar!: string;
  // @ts-expect-error nullable GraphQL field, non-null TS field
  @Field(() => String, { nullable: true }) mustBeNullable!: string;
  // @ts-expect-error non-null GraphQL field, optional TS field
  @Field(() => String) mustBeRequired?: string;
  // @ts-expect-error nullable needs both null and undefined
  @Field(() => String, { nullable: true }) onlyNull!: string | null;
  // @ts-expect-error wrong class
  @Field(() => Post) wrongClass!: User;
  // @ts-expect-error list vs single
  @Field(() => [String]) notAList!: string;
  // @ts-expect-error nullable items, non-null TS items
  @Field(() => [String], { nullable: 'items' }) items!: string[];
  // @ts-expect-error enum value mismatch
  @Field(() => RoleType) wrongEnum!: 'OTHER';
}

const SearchResult = defineUnion({ name: 'SearchResult', types: () => [User, Post] });

@ObjectType()
class Holder {
  @Field(() => SearchResult) result!: User | Post;
  // @ts-expect-error a union field must accept every member
  @Field(() => SearchResult) narrow!: User;
}
void Holder;

@ArgsType()
class PageArgs {
  @Field(() => Int) first!: number;
  @Field(() => ID, { nullable: true }) after?: string | null;
}

@Resolver(() => User)
export class UserResolver {
  @Query(() => [User]) users(): User[] {
    return [];
  }
  @Query(() => User, { nullable: true, args: { id: ID } })
  async user(ctx: ResolverCtx<{ id: string }>): Promise<User | null> {
    assertType<Equal<typeof ctx.args, { id: string }>>();
    return null;
  }
  @Query(() => [User], { args: PageArgs })
  page(ctx: ResolverCtx<PageArgs>): User[] {
    return ctx.args.first > 0 ? [] : [];
  }
  @Query(() => Int, { args: { first: Int, after: { type: () => ID, nullable: true } } })
  count(ctx: ResolverCtx<{ first: number; after?: string | null }>) {
    return ctx.args.first;
  }
  @Mutation(() => Boolean, { args: { tags: [String] } })
  tag(ctx: ResolverCtx<{ tags: string[] }>) {
    return ctx.args.tags.length > 0;
  }
  @ResolveField(() => Int)
  postCount(ctx: ResolverCtx<{}, User>) {
    return ctx.parent.posts.length;
  }
  @Subscription(() => String, { topic: 'names' })
  names() {}

  // @ts-expect-error resolver returns string, declared Int
  @Query(() => Int) badReturn(): string {
    return '';
  }
  // @ts-expect-error declared non-null, returns nullable
  @Query(() => User) maybeUser(): User | null {
    return null;
  }
  // @ts-expect-error ctx args type disagrees with the declared args
  @Query(() => Int, { args: { id: ID } }) badArgs(ctx: ResolverCtx<{ id: number }>) {
    return ctx.args.id;
  }
  // @ts-expect-error ctx expects an argument that is not declared
  @Query(() => Int) undeclared(ctx: ResolverCtx<{ id: string }>) {
    return ctx.args.id.length;
  }
  // @ts-expect-error subscription method returns the wrong type
  @Subscription(() => String, { topic: 't' }) badSub() {
    return 1;
  }
}

export function typeAssertions(): void {
  assertType<Equal<TsOf<typeof ID>, string>>();
  assertType<Equal<TsOf<typeof Int>, number>>();
  assertType<Equal<TsOf<StringConstructor>, string>>();
  assertType<Equal<TsOf<typeof User>, User>>();
  assertType<Equal<TsOf<typeof SearchResult>, User | Post>>();
  assertType<Equal<TsOf<typeof RoleType>, Role>>();
}
