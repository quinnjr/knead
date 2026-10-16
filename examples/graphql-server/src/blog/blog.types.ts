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

/**
 * Rebuilds a Post from an event payload, which is plain JSON when it came through Redis. Only
 * the known fields are copied: a payload is never Object.assign-ed onto an entity.
 */
export function revivePost(payload: PostEvent): Post {
  const post = new Post();
  post.id = String(payload.id);
  post.authorId = String(payload.authorId);
  post.title = String(payload.title);
  post.body = String(payload.body);
  post.status = payload.status === PostStatus.PUBLISHED ? PostStatus.PUBLISHED : PostStatus.DRAFT;
  post.tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
  post.createdAt = new Date(payload.createdAt);
  post.publishedAt = payload.publishedAt ? new Date(payload.publishedAt) : null;
  return post;
}

export function reviveComment(payload: CommentEvent): Comment {
  const comment = new Comment();
  comment.id = String(payload.id);
  comment.postId = String(payload.postId);
  comment.authorId = String(payload.authorId);
  comment.body = String(payload.body);
  comment.createdAt = new Date(payload.createdAt);
  return comment;
}
