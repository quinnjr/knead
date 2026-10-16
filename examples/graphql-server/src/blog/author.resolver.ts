import { inject } from '@hpmws/core';
import { ID, Query, ResolveField, Resolver, type ResolverCtx } from '@hpmws/graphql';
import { PostsByAuthor } from './blog.loaders.js';
import { BlogService } from './blog.service.js';
import { Author, Post } from './blog.types.js';

@Resolver(() => Author)
export class AuthorResolver {
  readonly #blog = inject(BlogService);

  @Query(() => [Author])
  authors(): Author[] {
    return this.#blog.authors();
  }

  @Query(() => Author, { nullable: true, args: { id: ID } })
  author(ctx: ResolverCtx<{ id: string }>): Author | undefined {
    return this.#blog.author(ctx.args.id);
  }

  /** Batched per operation; drafts are filtered per viewer after the shared lookup. */
  @ResolveField(() => [Post])
  async posts(ctx: ResolverCtx<{}, Author>): Promise<Post[]> {
    const posts = await ctx.loader(PostsByAuthor).load(ctx.parent.id);
    return posts.filter((post) => this.#blog.visible(post, ctx.currentUser));
  }
}
