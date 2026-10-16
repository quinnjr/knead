import type { Comment, Post, PostStatus } from './blog.types.js';

/**
 * Event payloads. They are DTOs with explicit fields rather than the entities themselves, so a
 * field later added to an entity (or set on it at runtime) never leaks into PubSub, which may be
 * a shared Redis server. Dates become ISO strings when they go through Redis.
 */
export interface PostEvent {
  id: string;
  authorId: string;
  title: string;
  body: string;
  status: PostStatus;
  tags: string[];
  createdAt: Date | string;
  publishedAt: Date | string | null;
}

export interface CommentEvent {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: Date | string;
}

export function toPostEvent(post: Post): PostEvent {
  return {
    id: post.id,
    authorId: post.authorId,
    title: post.title,
    body: post.body,
    status: post.status,
    tags: [...post.tags],
    createdAt: post.createdAt,
    publishedAt: post.publishedAt ?? null,
  };
}

export function toCommentEvent(comment: Comment): CommentEvent {
  return {
    id: comment.id,
    postId: comment.postId,
    authorId: comment.authorId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}
