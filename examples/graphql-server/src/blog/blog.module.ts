import { Module } from '@knead-js/core';
import { AuthorResolver } from './author.resolver.js';
import { AuthorsById, CommentsByPost, PostsByAuthor } from './blog.loaders.js';
import { BlogMutations } from './blog.mutations.js';
import { BlogService } from './blog.service.js';
import { BlogSubscriptions } from './blog.subscriptions.js';
import { CommentResolver } from './comment.resolver.js';
import { PostResolver } from './post.resolver.js';
import { SearchResolver } from './search.resolver.js';

@Module({
  providers: [
    BlogService,
    AuthorsById,
    PostsByAuthor,
    CommentsByPost,
    PostResolver,
    AuthorResolver,
    CommentResolver,
    SearchResolver,
    BlogMutations,
    BlogSubscriptions,
  ],
  exports: [BlogService],
})
export class BlogModule {}
