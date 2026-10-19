import { inject, Module } from '@knead-js/core';
import { GraphQLModule } from '@knead-js/graphql';
import { BlogModule } from './blog.module.js';
import { SessionModule, SessionService } from './sessions.js';

// #region app-module
@Module({
  imports: [
    GraphQLModule.forRootAsync({
      // The factory runs in GraphQLModule's injection context, which sees these imports.
      imports: [SessionModule],
      useFactory: () => {
        const sessions = inject(SessionService);
        return {
          // Over HTTP: once per request. Over WebSocket and SSE subscriptions: on connect and
          // once per subscribe.
          context: (http) => ({
            member: sessions.fromAuthorization(http.req.headers.get('authorization')),
          }),
          subscriptions: {
            // Browsers cannot set Authorization on a WebSocket: the token is a connectionParam.
            // Over SSE, params is {} and the request carries the Authorization header.
            onConnect: (http, params) => {
              const member =
                sessions.verify(params.token) ??
                sessions.fromAuthorization(http.req.headers.get('authorization'));
              return member ? { member } : false;
            },
          },
        };
      },
    }),
    BlogModule,
  ],
})
export class AppModule {}
// #endregion app-module
