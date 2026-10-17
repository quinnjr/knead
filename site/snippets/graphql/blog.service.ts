import { inject } from '@knead-js/core';
import type { BatchLoader } from '@knead-js/graphql';
import { NotFoundException } from '@knead-js/http';
import { Author, type Node, Post, PostStatus } from './blog.types.js';

export interface NewPost {
  title: string;
  tags: string[];
  publish: boolean;
}

function author(id: string, name: string, bio: string | null): Author {
  const value = new Author();
  value.id = id;
  value.name = name;
  value.bio = bio;
  return value;
}

/** The blog's data, kept in memory. */
export class BlogService {
  readonly #authors = new Map<string, Author>([
    ['a1', author('a1', 'Ada Lovelace', 'Wrote the first published algorithm.')],
    ['a2', author('a2', 'Grace Hopper', null)],
  ]);
  readonly #posts = new Map<string, Post>();
  #nextId = 1;

  constructor() {
    this.createPost('a1', { title: 'Notes on the Analytical Engine', tags: [], publish: true });
    this.createPost('a2', { title: 'The first actual bug', tags: ['debugging'], publish: true });
    this.createPost('a1', { title: 'Poetical science', tags: [], publish: false });
  }

  posts(page: { first: number; offset: number; status?: PostStatus | null }): Post[] {
    return [...this.#posts.values()]
      .filter((post) => !page.status || post.status === page.status)
      .slice(page.offset, page.offset + page.first);
  }

  post(id: string): Post | undefined {
    return this.#posts.get(id);
  }

  /** One lookup for many authors, in key order (the DataLoader contract). */
  authorsByIds(ids: readonly string[]): (Author | Error)[] {
    return ids.map((id) => this.#authors.get(id) ?? new NotFoundException(`No author ${id}`));
  }

  node(id: string): Node | undefined {
    return this.#authors.get(id) ?? this.#posts.get(id);
  }

  search(term: string): (Post | Author)[] {
    const needle = term.toLowerCase();
    return [
      ...[...this.#posts.values()].filter((p) => p.title.toLowerCase().includes(needle)),
      ...[...this.#authors.values()].filter((a) => a.name.toLowerCase().includes(needle)),
    ];
  }

  createPost(authorId: string, input: NewPost): Post {
    const post = new Post();
    post.id = `p${this.#nextId++}`;
    post.authorId = authorId;
    post.title = input.title;
    post.tags = input.tags;
    post.words = 0;
    post.status = input.publish ? PostStatus.PUBLISHED : PostStatus.DRAFT;
    post.createdAt = new Date();
    post.publishedAt = input.publish ? post.createdAt : null;
    this.#posts.set(post.id, post);
    return post;
  }
}

// #region loader
/** `ctx.loader(AuthorsById)` gives each operation its own DataLoader over this singleton. */
export class AuthorsById implements BatchLoader<string, Author> {
  readonly #blog = inject(BlogService);
  /** How many times batch() ran (the tests read it). */
  calls = 0;

  async batch(ids: readonly string[]): Promise<(Author | Error)[]> {
    this.calls++;
    return this.#blog.authorsByIds(ids);
  }
}
// #endregion loader
