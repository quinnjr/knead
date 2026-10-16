// A small blog schema used by the schema, HTTP and snapshot tests.
import { inject, Module } from '@hpmws/core';
import { NotFoundException } from '@hpmws/http';
import {
  ArgsType,
  type BatchLoader,
  defineEnum,
  defineUnion,
  Field,
  ID,
  InputType,
  Int,
  InterfaceType,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
} from '../../src/index.js';

export enum Role {
  ADMIN = 'ADMIN',
  READER = 'READER',
}
export const RoleType = defineEnum(Role, { name: 'Role', description: 'What a user may do' });

@InterfaceType({ description: 'Anything with an id' })
export class Node {
  @Field(() => ID) id!: string;
}

@ObjectType({ implements: () => [Node] })
export class User extends Node {
  @Field(() => String) name!: string;
  @Field(() => RoleType) role!: Role;
  @Field(() => String, { nullable: true, description: 'Free text' }) bio?: string | null;
}

@ObjectType({ implements: () => [Node] })
export class Post extends Node {
  @Field(() => String) title!: string;
  @Field(() => [String]) tags!: string[];
  authorId!: string;
}

export const SearchResult = defineUnion({ name: 'SearchResult', types: () => [User, Post] });

@InputType()
export class CreatePostInput {
  @Field(() => String) title!: string;
  @Field(() => [String], { nullable: true }) tags?: string[] | null;
}

@ArgsType()
export class PageArgs {
  @Field(() => Int, { defaultValue: 10 }) first!: number;
  @Field(() => ID, { nullable: true }) after?: string | null;
}

export class Store {
  readonly users = new Map<string, User>();
  readonly posts = new Map<string, Post>();
  userBatches: string[][] = [];

  constructor() {
    this.addUser('u1', 'Ada', Role.ADMIN);
    this.addUser('u2', 'Grace', Role.READER);
    this.addPost('p1', 'Hello', 'u1', ['intro']);
    this.addPost('p2', 'Again', 'u2', []);
    this.addPost('p3', 'More', 'u1', ['misc']);
  }

  addUser(id: string, name: string, role: Role): User {
    const user = Object.assign(new User(), { id, name, role, bio: null });
    this.users.set(id, user);
    return user;
  }

  addPost(id: string, title: string, authorId: string, tags: string[]): Post {
    const post = Object.assign(new Post(), { id, title, authorId, tags });
    this.posts.set(id, post);
    return post;
  }
}

export class UserLoader implements BatchLoader<string, User> {
  readonly #store = inject(Store);
  async batch(ids: readonly string[]): Promise<(User | Error)[]> {
    this.#store.userBatches.push([...ids]);
    return ids.map((id) => this.#store.users.get(id) ?? new NotFoundException(`User ${id}`));
  }
}

@Resolver(() => Post)
export class PostResolver {
  readonly #store = inject(Store);

  @Query(() => [Post], { args: PageArgs })
  posts(ctx: ResolverCtx<PageArgs>): Post[] {
    return [...this.#store.posts.values()].slice(0, ctx.args.first);
  }

  @Query(() => Post, { nullable: true, args: { id: ID } })
  post(ctx: ResolverCtx<{ id: string }>): Post | undefined {
    return this.#store.posts.get(ctx.args.id);
  }

  @Query(() => [SearchResult], { args: { term: String } })
  search(ctx: ResolverCtx<{ term: string }>): (User | Post)[] {
    const term = ctx.args.term.toLowerCase();
    return [
      ...[...this.#store.users.values()].filter((u) => u.name.toLowerCase().includes(term)),
      ...[...this.#store.posts.values()].filter((p) => p.title.toLowerCase().includes(term)),
    ];
  }

  @Mutation(() => Post, { args: { input: CreatePostInput } })
  createPost(ctx: ResolverCtx<{ input: CreatePostInput }>): Post {
    const id = `p${this.#store.posts.size + 1}`;
    return this.#store.addPost(id, ctx.args.input.title, 'u1', ctx.args.input.tags ?? []);
  }

  @ResolveField(() => User)
  author(ctx: ResolverCtx<{}, Post>): Promise<User> {
    return ctx.loader(UserLoader).load(ctx.parent.authorId);
  }
}

@Resolver(() => User)
export class UserResolver {
  readonly #store = inject(Store);

  @Query(() => User, { args: { id: ID } })
  user(ctx: ResolverCtx<{ id: string }>): User {
    const user = this.#store.users.get(ctx.args.id);
    if (!user) throw new NotFoundException(`User ${ctx.args.id} not found`);
    return user;
  }

  @ResolveField(() => [Post])
  posts(ctx: ResolverCtx<{}, User>): Post[] {
    return [...this.#store.posts.values()].filter((p) => p.authorId === ctx.parent.id);
  }
}

@Module({
  providers: [Store, UserLoader, PostResolver, UserResolver],
  exports: [Store],
})
export class BlogModule {}
