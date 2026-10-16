import { ResolveField, Resolver, type ResolverCtx } from '@knead-js/graphql';
import { AuthorsById } from './blog.loaders.js';
import { Author, Comment } from './blog.types.js';

@Resolver(() => Comment)
export class CommentResolver {
  /** Shares the operation's AuthorsById DataLoader with Post.author. */
  @ResolveField(() => Author)
  author(ctx: ResolverCtx<{}, Comment>): Promise<Author> {
    return ctx.loader(AuthorsById).load(ctx.parent.authorId);
  }
}
