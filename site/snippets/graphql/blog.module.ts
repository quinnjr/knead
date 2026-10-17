import { Module } from '@knead-js/core';
import { AuthorsById, BlogService } from './blog.service.js';
import { PostResolver, SearchResolver } from './post.resolver.js';
import { PostSubscriptions } from './post.subscriptions.js';

// #region blog-module
@Module({
  providers: [BlogService, AuthorsById, PostResolver, SearchResolver, PostSubscriptions],
  exports: [BlogService],
})
export class BlogModule {}
// #endregion blog-module
