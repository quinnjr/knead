import { Module } from '@knead-js/core';
import { GraphQLModule } from '@knead-js/graphql';
import { BlogModule } from './blog.module.js';

// #region playground
@Module({
  imports: [
    GraphQLModule.forRoot({
      // On in development by default. An object turns it on and sets where the page connects
      // for subscriptions (a ws:// or wss:// URL, or an absolute path).
      playground: { subscriptionEndpoint: 'wss://api.example.com/graphql' },
    }),
    BlogModule,
  ],
})
export class PlaygroundAppModule {}
// #endregion playground
