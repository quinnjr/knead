import {
  ArgsType,
  defineEnum,
  defineUnion,
  Field,
  ID,
  InputType,
  Int,
  InterfaceType,
  ObjectType,
} from '@hpmws/graphql';
import { sanitize } from '@hpmws/sanitize';
import type { CommentEvent, PostEvent } from './blog.events.js';
import { DateTime } from './date-time.scalar.js';

export enum PostStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
}

export const PostStatusType = defineEnum(PostStatus, {
  name: 'PostStatus',
  description: 'Whether a post is visible to readers',
});

@InterfaceType({ description: 'An object with a globally unique id' })
export class Node {
  @Field(() => ID) id!: string;
}

@ObjectType({ implements: () => [Node] })
export class Author extends Node {
  @Field(() => String) name!: string;
  @Field(() => String, { nullable: true }) bio?: string | null;
  // `posts` is resolved by AuthorResolver.
}

@ObjectType({ implements: () => [Node] })
export class Post extends Node {
  @Field(() => String) title!: string;
  @Field(() => String, { description: 'Sanitized HTML' }) body!: string;
  @Field(() => PostStatusType) status!: PostStatus;
  @Field(() => [String]) tags!: string[];
  @Field(() => DateTime) createdAt!: Date;
  @Field(() => DateTime, { nullable: true }) publishedAt?: Date | null;
  /** Not exposed; `author` is resolved by PostResolver through a DataLoader. */
  authorId!: string;
}

@ObjectType({ implements: () => [Node] })
export class Comment extends Node {
  @Field(() => ID) postId!: string;
  @Field(() => String, { description: 'Sanitized HTML' }) body!: string;
  @Field(() => DateTime) createdAt!: Date;
  authorId!: string;
}

export const SearchResult = defineUnion({
  name: 'SearchResult',
  description: 'A post or an author matching a search term',
  types: () => [Post, Author],
});

@InputType()
export class CreatePostInput {
  @Field(() => String) title!: string;
  @Field(() => String, { description: 'HTML; sanitized on input' }) body!: string;
  @Field(() => [String], { nullable: true }) tags?: string[] | null;
  @Field(() => Boolean, { nullable: true, defaultValue: false }) publish?: boolean | null;
}

@ArgsType()
export class PageArgs {
  @Field(() => Int, { defaultValue: 10 }) first!: number;
  @Field(() => Int, { defaultValue: 0 }) offset!: number;
}

@ArgsType()
export class PostsArgs extends PageArgs {
  @Field(() => PostStatusType, { nullable: true }) status?: PostStatus | null;
  @Field(() => DateTime, { nullable: true, description: 'Only posts created at or after this' })
  since?: Date | null;
}

/** Every PostStatus value, for validating events. */
const STATUSES = new Set<unknown>(Object.values(PostStatus));

/**
 * Whether a PubSub payload is a well-formed post event. Events may come from Redis, a trust
 * boundary: anything else is dropped by the subscription's filter.
 */
export function isPostEvent(payload: unknown): payload is PostEvent {
  const p = payload as Partial<PostEvent> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    typeof p.authorId === 'string' &&
    typeof p.body === 'string' &&
    STATUSES.has(p.status)
  );
}

/** Whether a PubSub payload is a well-formed comment event. */
export function isCommentEvent(payload: unknown): payload is CommentEvent {
  const c = payload as Partial<CommentEvent> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.id === 'string' &&
    typeof c.postId === 'string' &&
    typeof c.body === 'string'
  );
}

/**
 * Rebuilds a Post from an event payload, which is plain JSON when it came through Redis. Only
 * the known fields are copied (a payload is never Object.assign-ed onto an entity), and since
 * the event crossed a trust boundary the body is sanitized again and the status must be a
 * PostStatus.
 */
export function revivePost(payload: PostEvent): Post {
  if (!STATUSES.has(payload.status)) throw new TypeError('Invalid post status in event');
  const post = new Post();
  post.id = String(payload.id);
  post.authorId = String(payload.authorId);
  post.title = String(payload.title);
  post.body = sanitize(String(payload.body), 'basic');
  post.status = payload.status;
  post.tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
  post.createdAt = new Date(payload.createdAt);
  post.publishedAt = payload.publishedAt ? new Date(payload.publishedAt) : null;
  return post;
}

/** Rebuilds a Comment from an event; the body is sanitized again (see revivePost). */
export function reviveComment(payload: CommentEvent): Comment {
  const comment = new Comment();
  comment.id = String(payload.id);
  comment.postId = String(payload.postId);
  comment.authorId = String(payload.authorId);
  comment.body = sanitize(String(payload.body), 'basic');
  comment.createdAt = new Date(payload.createdAt);
  return comment;
}
