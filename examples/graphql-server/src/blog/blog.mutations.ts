import { AbilityService, asSubject, Can } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { ID, Mutation, PUBSUB, Resolver, type ResolverCtx } from '@knead-js/graphql';
import { sanitize } from '@knead-js/sanitize';
import * as v from 'valibot';
import { toCommentEvent, toPostEvent } from './blog.events.js';
import { BlogService } from './blog.service.js';
import { Comment, CreatePostInput, Post } from './blog.types.js';
import { commentTopic, POST_PUBLISHED } from './topics.js';

const Html = (max: number) =>
  v.pipe(
    v.string(),
    v.maxLength(max),
    v.transform((html) => sanitize(html, 'basic')),
    v.minLength(1, 'Must contain some text after sanitizing'),
  );

const CreatePost = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(120)),
  body: Html(10_000),
  tags: v.pipe(
    v.nullish(v.array(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.minLength(1))), []),
    v.maxLength(5),
  ),
  publish: v.nullish(v.boolean(), false),
});

/**
 * Every mutation needs a token (AbilityGuard: UNAUTHENTICATED otherwise) whose grant and user
 * allow the @Can() action (FORBIDDEN otherwise).
 */
@Resolver()
export class BlogMutations {
  readonly #abilities = inject(AbilityService);
  readonly #blog = inject(BlogService);
  readonly #pubsub = inject(PUBSUB);

  @Mutation(() => Post, { args: { input: CreatePostInput }, validate: { input: CreatePost } })
  @Can('create', 'Post')
  createPost(ctx: ResolverCtx<{ input: CreatePostInput }>): Post {
    // `validate` has replaced the coerced input with the schema's output.
    const input = ctx.args.input as v.InferOutput<typeof CreatePost>;
    const post = this.#blog.createPost(ctx.currentUser!.id, input);
    if (post.publishedAt) void this.#pubsub.publish(POST_PUBLISHED, toPostEvent(post));
    return post;
  }

  @Mutation(() => Post, { args: { id: ID } })
  @Can('update', 'Post')
  async publishPost(ctx: ResolverCtx<{ id: string }>): Promise<Post> {
    const existing = this.#blog.requireVisible(ctx.args.id, ctx.currentUser);
    // @Can checked `update` on posts in general; the record decides the rest: users may update
    // their own posts (`{ authorId: user.id }`), admins any post.
    await this.#abilities.authorize(ctx, 'update', asSubject('Post', existing));
    const wasPublished = existing.publishedAt != null;
    const post = this.#blog.publish(ctx.args.id);
    if (!wasPublished) void this.#pubsub.publish(POST_PUBLISHED, toPostEvent(post));
    return post;
  }

  @Mutation(() => Comment, {
    args: { postId: ID, body: String },
    validate: { body: Html(2000) },
  })
  @Can('create', 'Comment')
  addComment(ctx: ResolverCtx<{ postId: string; body: string }>): Comment {
    const user = ctx.currentUser!;
    this.#blog.requireVisible(ctx.args.postId, user);
    const comment = this.#blog.addComment(ctx.args.postId, user.id, ctx.args.body);
    void this.#pubsub.publish(commentTopic(comment.postId), toCommentEvent(comment));
    return comment;
  }

  /** Admins only, through a token granted `blog:admin`. */
  @Mutation(() => Boolean, { args: { id: ID } })
  @Can('delete', 'Post')
  deletePost(ctx: ResolverCtx<{ id: string }>): boolean {
    return this.#blog.deletePost(ctx.args.id);
  }
}
