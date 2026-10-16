import type { OnModuleInit } from '@hpmws/core';
import { NotFoundException } from '@hpmws/http';
import { Author, Comment, type Node, Post, PostStatus } from './blog.types.js';

export interface PostQuery {
  status?: PostStatus | null;
  since?: Date | null;
  first: number;
  offset: number;
}

export interface NewPost {
  title: string;
  body: string;
  tags: string[];
  publish: boolean;
}

/** The blog's data, kept in memory and seeded at startup. */
export class BlogService implements OnModuleInit {
  readonly #authors = new Map<string, Author>();
  readonly #posts = new Map<string, Post>();
  readonly #comments = new Map<string, Comment>();
  #nextId = 1;

  onModuleInit(): void {
    this.#addAuthor('a1', 'Ada Lovelace', 'Wrote the first published algorithm.');
    this.#addAuthor('a2', 'Grace Hopper', null);
    this.#addAuthor('a3', 'Alan Turing', 'Asked whether machines can think.');
    const seed: [string, string, string, string[], string, boolean][] = [
      [
        'a1',
        'Notes on the Analytical Engine',
        '<p>Bernoulli numbers.</p>',
        ['history'],
        '2026-01-10T09:00:00.000Z',
        true,
      ],
      [
        'a2',
        'The first actual bug',
        '<p>A moth in relay 70.</p>',
        ['debugging'],
        '2026-02-01T12:00:00.000Z',
        true,
      ],
      [
        'a3',
        'The imitation game',
        '<p>Can machines think?</p>',
        [],
        '2026-03-15T15:30:00.000Z',
        true,
      ],
      ['a1', 'Poetical science', '<p>Work in progress.</p>', [], '2026-04-01T08:00:00.000Z', false],
    ];
    for (const [authorId, title, body, tags, at, published] of seed) {
      const post = this.#addPost(authorId, title, body, tags, new Date(at));
      if (published) this.publish(post.id, post.createdAt);
    }
    this.addComment('p2', 'a1', '<p>Wonderful <em>find</em>.</p>');
  }

  posts(query: PostQuery): Post[] {
    return [...this.#posts.values()]
      .filter((p) => !query.status || p.status === query.status)
      .filter((p) => !query.since || p.createdAt >= query.since)
      .slice(query.offset, query.offset + query.first);
  }

  post(id: string): Post | undefined {
    return this.#posts.get(id);
  }

  authors(): Author[] {
    return [...this.#authors.values()];
  }

  author(id: string): Author | undefined {
    return this.#authors.get(id);
  }

  /** One lookup for many authors, in key order (DataLoader's contract). */
  authorsByIds(ids: readonly string[]): (Author | Error)[] {
    return ids.map(
      (id) => this.#authors.get(id) ?? new NotFoundException(`Author ${id} not found`),
    );
  }

  /** One lookup for the posts of many authors, in key order. */
  postsByAuthorIds(ids: readonly string[]): Post[][] {
    const posts = [...this.#posts.values()];
    return ids.map((id) => posts.filter((p) => p.authorId === id));
  }

  commentsFor(postId: string): Comment[] {
    return [...this.#comments.values()].filter((c) => c.postId === postId);
  }

  node(id: string): Node | undefined {
    return this.#authors.get(id) ?? this.#posts.get(id) ?? this.#comments.get(id);
  }

  search(term: string): (Post | Author)[] {
    const needle = term.toLowerCase();
    return [
      ...[...this.#posts.values()].filter(
        (p) => p.status === PostStatus.PUBLISHED && p.title.toLowerCase().includes(needle),
      ),
      ...[...this.#authors.values()].filter((a) => a.name.toLowerCase().includes(needle)),
    ];
  }

  createPost(authorId: string, input: NewPost): Post {
    const post = this.#addPost(authorId, input.title, input.body, input.tags);
    if (input.publish) this.publish(post.id);
    return post;
  }

  publish(id: string, at = new Date()): Post {
    const post = this.#require(id);
    post.status = PostStatus.PUBLISHED;
    post.publishedAt ??= at;
    return post;
  }

  deletePost(id: string): boolean {
    this.#require(id);
    for (const comment of this.commentsFor(id)) this.#comments.delete(comment.id);
    return this.#posts.delete(id);
  }

  addComment(postId: string, authorId: string, body: string): Comment {
    this.#require(postId);
    const comment = Object.assign(new Comment(), {
      id: `c${this.#nextId++}`,
      postId,
      authorId,
      body,
      createdAt: new Date(),
    });
    this.#comments.set(comment.id, comment);
    return comment;
  }

  #require(id: string): Post {
    const post = this.#posts.get(id);
    if (!post) throw new NotFoundException(`Post ${id} not found`);
    return post;
  }

  #addAuthor(id: string, name: string, bio: string | null): void {
    this.#authors.set(id, Object.assign(new Author(), { id, name, bio }));
  }

  #addPost(
    authorId: string,
    title: string,
    body: string,
    tags: string[],
    createdAt = new Date(),
  ): Post {
    const post = Object.assign(new Post(), {
      id: `p${this.#nextId++}`,
      authorId,
      title,
      body,
      tags,
      status: PostStatus.DRAFT,
      createdAt,
      publishedAt: null,
    });
    this.#posts.set(post.id, post);
    return post;
  }
}
