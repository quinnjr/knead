import { inject } from '@hpmws/core';
import { ID, Mutation, PUBSUB, Resolver, type ResolverCtx } from '@hpmws/graphql';
import { ForbiddenException, UseGuards } from '@hpmws/http';
import { sanitize } from '@hpmws/sanitize';
import * as v from 'valibot';
import { Authenticated, Roles, RolesGuard } from '../auth/auth.js';
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

/** Every mutation needs a signed-in user (class guard, runs first). */
@Resolver()
@UseGuards(Authenticated)
export class BlogMutations {
  readonly #blog = inject(BlogService);
  readonly #pubsub = inject(PUBSUB);

  @Mutation(() => Post, { args: { input: CreatePostInput }, validate: { input: CreatePost } })
  createPost(ctx: ResolverCtx<{ input: CreatePostInput }>): Post {
    // `validate` has replaced the coerced input with the schema's output.
    const input = ctx.args.input as v.InferOutput<typeof CreatePost>;
    const post = this.#blog.createPost(ctx.currentUser!.id, input);
    if (post.publishedAt) void this.#pubsub.publish(POST_PUBLISHED, post);
    return post;
  }

  @Mutation(() => Post, { args: { id: ID } })
  publishPost(ctx: ResolverCtx<{ id: string }>): Post {
    const user = ctx.currentUser!;
    const existing = this.#blog.requireVisible(ctx.args.id, user);
    if (existing.authorId !== user.id && !user.roles.includes('admin')) {
      throw new ForbiddenException('Only the author or an admin can publish this post.');
    }
    const wasPublished = existing.publishedAt != null;
    const post = this.#blog.publish(ctx.args.id);
    if (!wasPublished) void this.#pubsub.publish(POST_PUBLISHED, post);
    return post;
  }

  @Mutation(() => Comment, {
    args: { postId: ID, body: String },
    validate: { body: Html(2000) },
  })
  addComment(ctx: ResolverCtx<{ postId: string; body: string }>): Comment {
    const user = ctx.currentUser!;
    this.#blog.requireVisible(ctx.args.postId, user);
    const comment = this.#blog.addComment(ctx.args.postId, user.id, ctx.args.body);
    void this.#pubsub.publish(commentTopic(comment.postId), comment);
    return comment;
  }

  /** Admin only: RolesGuard reads @Roles() through ctx.meta and returns false (FORBIDDEN). */
  @Mutation(() => Boolean, { args: { id: ID } })
  @UseGuards(RolesGuard)
  @Roles('admin')
  deletePost(ctx: ResolverCtx<{ id: string }>): boolean {
    return this.#blog.deletePost(ctx.args.id);
  }
}
