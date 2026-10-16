import { inject } from '@hpmws/core';
import { ID, Query, ResolveField, Resolver, type ResolverCtx } from '@hpmws/graphql';
import * as v from 'valibot';
import { AuthorsById } from './blog.loaders.js';
import { BlogService } from './blog.service.js';
import { Author, Comment, Post, PostsArgs } from './blog.types.js';

const PageSize = v.pipe(v.number(), v.minValue(1), v.maxValue(50));
const Offset = v.pipe(v.number(), v.minValue(0));

@Resolver(() => Post)
export class PostResolver {
  readonly #blog = inject(BlogService);

  @Query(() => [Post], { args: PostsArgs, validate: { first: PageSize, offset: Offset } })
  posts(ctx: ResolverCtx<PostsArgs>): Post[] {
    return this.#blog.posts(ctx.args, ctx.currentUser);
  }

  @Query(() => Post, { nullable: true, args: { id: ID } })
  post(ctx: ResolverCtx<{ id: string }>): Post | undefined {
    return this.#blog.post(ctx.args.id, ctx.currentUser);
  }

  /** Batched: every Post.author in one operation tick becomes one AuthorsById.batch() call. */
  @ResolveField(() => Author)
  author(ctx: ResolverCtx<{}, Post>): Promise<Author> {
    return ctx.loader(AuthorsById).load(ctx.parent.authorId);
  }

  @ResolveField(() => [Comment])
  comments(ctx: ResolverCtx<{}, Post>): Comment[] {
    return this.#blog.commentsFor(ctx.parent.id);
  }
}
