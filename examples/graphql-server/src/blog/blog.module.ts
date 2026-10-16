import { Module } from '@knead/core';
import { AuthorResolver } from './author.resolver.js';
import { AuthorsById, PostsByAuthor } from './blog.loaders.js';
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
