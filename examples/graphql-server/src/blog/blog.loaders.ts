import { inject } from '@hpmws/core';
import type { BatchLoader } from '@hpmws/graphql';
import { BlogService } from './blog.service.js';
import type { Author, Post } from './blog.types.js';

/**
 * Authors by id. `ctx.loader(AuthorsById)` gives each operation its own DataLoader over this
 * singleton, so the `author` fields of a whole list are fetched in one `batch()` call.
 */
export class AuthorsById implements BatchLoader<string, Author> {
  readonly #blog = inject(BlogService);
  /** How many times batch() ran; tests read it to prove batching. */
  batchCalls = 0;

  async batch(ids: readonly string[]): Promise<(Author | Error)[]> {
    this.batchCalls++;
    return this.#blog.authorsByIds(ids);
  }
}

/** Posts by author id, batched the same way. */
export class PostsByAuthor implements BatchLoader<string, Post[]> {
  readonly #blog = inject(BlogService);
  batchCalls = 0;

  async batch(ids: readonly string[]): Promise<Post[][]> {
    this.batchCalls++;
    return this.#blog.postsByAuthorIds(ids);
  }
}
