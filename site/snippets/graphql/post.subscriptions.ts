import { inject } from '@knead-js/core';
import { ID, Resolver, Subscription, type SubscriptionCtx } from '@knead-js/graphql';
import { NotFoundException } from '@knead-js/http';
import { BlogService } from './blog.service.js';
import { Post } from './blog.types.js';
import { POST_PUBLISHED } from './post.resolver.js';

/** What the createPost mutation publishes: a plain DTO, never the entity itself. */
export interface PostPublishedEvent {
  id: string;
  authorId: string;
}

function isPostPublishedEvent(payload: unknown): payload is PostPublishedEvent {
  const event = payload as Partial<PostPublishedEvent> | null;
  return typeof event?.id === 'string' && typeof event.authorId === 'string';
}

// #region subscriptions
@Resolver()
export class PostSubscriptions {
  readonly #blog = inject(BlogService);

  @Subscription(() => Post, {
    args: { authorId: { type: () => ID, nullable: true } },
    topic: POST_PUBLISHED,
    // Runs for every event; false skips it for this subscriber.
    filter: ({ payload, args }) =>
      isPostPublishedEvent(payload) &&
      (args.authorId == null || payload.authorId === args.authorId),
  })
  postPublished(ctx: SubscriptionCtx<{ authorId?: string | null }, PostPublishedEvent>): Post {
    // ctx.parent is the event. A method that returns nothing sends the event itself.
    const post = this.#blog.post(ctx.parent.id);
    if (!post) throw new NotFoundException(`No post ${ctx.parent.id}`);
    return post;
  }

  @Subscription(() => String, {
    args: { room: ID },
    // A computed topic: one per room. Wildcards ("*", "#") in it are rejected.
    topic: (ctx) => `chat.${ctx.args.room}`,
    resolve: (payload: { text: string }) => payload.text,
  })
  message() {}
}
// #endregion subscriptions
