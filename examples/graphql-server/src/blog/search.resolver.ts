import { SkipAbility } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { ID, Query, Resolver, type ResolverCtx } from '@knead-js/graphql';
import * as v from 'valibot';
import { BlogService } from './blog.service.js';
import { type Author, Node, type Post, SearchResult } from './blog.types.js';

const Term = v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100));

@Resolver()
export class SearchResolver {
  readonly #blog = inject(BlogService);

  /** A union: each result is resolved to Post or Author by its class. */
  @Query(() => [SearchResult], { args: { term: String }, validate: { term: Term } })
  @SkipAbility()
  search(ctx: ResolverCtx<{ term: string }>): (Post | Author)[] {
    return this.#blog.search(ctx.args.term);
  }

  /** An interface: any Author, Post or Comment by id. */
  @Query(() => Node, { nullable: true, args: { id: ID } })
  @SkipAbility()
  node(ctx: ResolverCtx<{ id: string }>): Node | undefined {
    return this.#blog.node(ctx.args.id, ctx.currentUser);
  }
}
