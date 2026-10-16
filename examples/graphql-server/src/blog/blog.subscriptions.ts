import { ID, Resolver, Subscription } from '@hpmws/graphql';
import { Comment, Post, reviveComment, revivePost } from './blog.types.js';
import { commentTopic, POST_PUBLISHED } from './topics.js';

/** Subscribers are authenticated once, by `subscriptions.onConnect` (see app.module.ts). */
@Resolver()
export class BlogSubscriptions {
  @Subscription(() => Post, {
    args: { authorId: { type: () => ID, nullable: true } },
    topic: POST_PUBLISHED,
    filter: ({ payload, args }) => args.authorId == null || payload.authorId === args.authorId,
    resolve: revivePost,
  })
  postPublished() {}

  @Subscription(() => Comment, {
    args: { postId: ID },
    topic: (ctx) => commentTopic(ctx.args.postId),
    resolve: reviveComment,
  })
  commentAdded() {}
}
