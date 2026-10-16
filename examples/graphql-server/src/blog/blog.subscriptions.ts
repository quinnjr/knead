import { inject } from '@hpmws/core';
import { ID, Resolver, type ResolverCtx, Subscription } from '@hpmws/graphql';
import { type Guard, UseGuards } from '@hpmws/http';
import { BlogService } from './blog.service.js';
import {
  Comment,
  isCommentEvent,
  isPostEvent,
  Post,
  reviveComment,
  revivePost,
} from './blog.types.js';
import { commentTopic, POST_PUBLISHED } from './topics.js';

/** Subscribing to a post's comments requires being able to see the post (drafts: author or admin). */
export class PostVisibleGuard implements Guard<ResolverCtx<{ postId: string }>> {
  readonly #blog = inject(BlogService);

  canActivate(ctx: ResolverCtx<{ postId: string }>): boolean {
    this.#blog.requireVisible(ctx.args.postId, ctx.currentUser);
    return true;
  }
}

/** Subscribers are authenticated once, by `subscriptions.onConnect` (see app.module.ts). */
@Resolver()
export class BlogSubscriptions {
  @Subscription(() => Post, {
    args: { authorId: { type: () => ID, nullable: true } },
    topic: POST_PUBLISHED,
    // Malformed events (for example injected into Redis) are dropped before they resolve.
    filter: ({ payload, args }) =>
      isPostEvent(payload) && (args.authorId == null || payload.authorId === args.authorId),
    resolve: revivePost,
  })
  postPublished() {}

  // recheckGuards: PostVisibleGuard runs again before every comment, so a subscriber stops
  // receiving comments once the post is deleted or no longer visible to them.
  @Subscription(() => Comment, {
    args: { postId: ID },
    topic: (ctx) => commentTopic(ctx.args.postId),
    filter: ({ payload }) => isCommentEvent(payload),
    resolve: reviveComment,
    recheckGuards: true,
  })
  @UseGuards(PostVisibleGuard)
  commentAdded() {}
}
