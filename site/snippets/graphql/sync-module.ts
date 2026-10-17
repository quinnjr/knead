import { Module } from '@knead-js/core';
import { GraphQLModule } from '@knead-js/graphql';
import { BlogModule } from './blog.module.js';
import { SessionService } from './sessions.js';

// #region sync
const sessions = new SessionService();

@Module({
  imports: [
    GraphQLModule.forRoot({
      path: '/api/graphql',
      context: (http) => ({
        member: sessions.fromAuthorization(http.req.headers.get('authorization')),
      }),
    }),
    BlogModule,
  ],
})
export class StaticAppModule {}
// #endregion sync
