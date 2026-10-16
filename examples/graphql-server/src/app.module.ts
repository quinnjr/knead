import { inject, Module } from '@hpmws/core';
import { CorsModule } from '@hpmws/cors';
import { GraphQLModule, PubSub, RedisPubSub } from '@hpmws/graphql';
import { RateLimitModule } from '@hpmws/rate-limit';
import { SecurityHeadersModule } from '@hpmws/security-headers';
import { AuthModule, AuthService } from './auth/auth.js';
import { BlogModule } from './blog/blog.module.js';
import { config } from './config.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    CorsModule.forRoot({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
    RateLimitModule.forRoot({ limit: config.rateLimit, window: '1m' }),
    SecurityHeadersModule.forRoot(),
    // Playground, introspection and unmasked errors follow NODE_ENV=development.
    GraphQLModule.forRootAsync({
      imports: [AuthModule],
      useFactory: () => {
        const auth = inject(AuthService);
        return {
          // HTTP: the bearer token. Over WebSocket this runs on the upgrade request, and the
          // object onConnect returned is merged over it.
          context: (http) => ({
            currentUser: auth.fromAuthorization(http.req.headers.get('authorization')),
          }),
          subscriptions: {
            // Browsers cannot set Authorization on a WebSocket: the token is a connectionParam.
            onConnect: (_http, params) => {
              const currentUser = auth.verify(params.token);
              return currentUser ? { currentUser } : false;
            },
            allowedOrigins: config.corsOrigins,
          },
          pubsub: config.redisUrl ? new RedisPubSub({ url: config.redisUrl }) : new PubSub(),
        };
      },
    }),
    BlogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
