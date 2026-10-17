import { inject } from '@knead-js/core';
import {
  type ArgsOf,
  ID,
  Mutation,
  PUBSUB,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
} from '@knead-js/graphql';
import { UnauthorizedException } from '@knead-js/http';
import * as v from 'valibot';
import { AuthorsById, BlogService } from './blog.service.js';
import { Author, CreatePostInput, Node, Post, PostsArgs, SearchResult } from './blog.types.js';

export const POST_PUBLISHED = 'post.published';

// #region validate-schemas
const PageSize = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50));
const Term = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));
const NewPost = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(120)),
  tags: v.pipe(
    v.nullish(v.array(v.pipe(v.string(), v.trim(), v.toLowerCase())), []),
    v.maxLength(5),
  ),
  publish: v.nullish(v.boolean(), false),
});
// #endregion validate-schemas

// #region args-of
const postOptions = { nullable: true, args: { id: ID } } as const;
type PostArgs = ArgsOf<typeof postOptions>; // { id: string }
// #endregion args-of

// #region resolver
@Resolver(() => Post)
export class PostResolver {
  readonly #blog = inject(BlogService);
  readonly #pubsub = inject(PUBSUB);

  @Query(() => [Post], { args: PostsArgs, validate: { first: PageSize } })
  posts(ctx: ResolverCtx<PostsArgs>): Post[] {
    return this.#blog.posts(ctx.args);
  }

  @Query(() => Post, postOptions)
  post(ctx: ResolverCtx<PostArgs>): Post | undefined {
    return this.#blog.post(ctx.args.id);
  }

  @ResolveField(() => Author, { description: 'Batched through AuthorsById' })
  author(ctx: ResolverCtx<{}, Post>): Promise<Author> {
    return ctx.loader(AuthorsById).load(ctx.parent.authorId);
  }

  @Mutation(() => Post, { args: { input: CreatePostInput }, validate: { input: NewPost } })
  createPost(ctx: ResolverCtx<{ input: CreatePostInput }>): Post {
    const member = ctx.member;
    if (!member) throw new UnauthorizedException('Sign in to write posts.');
    // validate has replaced the input with the schema's output: trimmed, defaults applied.
    const { title, tags, publish } = ctx.args.input;
    const post = this.#blog.createPost(member.id, {
      title,
      tags: tags ?? [],
      publish: publish ?? false,
    });
    if (post.publishedAt) {
      void this.#pubsub.publish(POST_PUBLISHED, { id: post.id, authorId: post.authorId });
    }
    return post;
  }
}
// #endregion resolver

// #region search
@Resolver()
export class SearchResolver {
  readonly #blog = inject(BlogService);

  @Query(() => [SearchResult], { args: { term: String }, validate: { term: Term } })
  search(ctx: ResolverCtx<{ term: string }>): (Post | Author)[] {
    return this.#blog.search(ctx.args.term);
  }

  @Query(() => Node, { nullable: true, args: { id: ID } })
  node(ctx: ResolverCtx<{ id: string }>): Node | undefined {
    return this.#blog.node(ctx.args.id);
  }
}
// #endregion search
