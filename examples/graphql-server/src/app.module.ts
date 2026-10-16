import { inject, Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { GraphQLModule, PubSub, RedisPubSub } from '@knead-js/graphql';
import { RateLimitModule, RedisStore } from '@knead-js/rate-limit';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { AuthModule, AuthService } from './auth/auth.js';
import { BlogModule } from './blog/blog.module.js';
import { config, redisPubSubOptions } from './config.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    CorsModule.forRoot({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
    RateLimitModule.forRoot({
      limit: config.rateLimit,
      window: '1m',
      store:
        config.redisUrl && config.rateLimitHashSecret
          ? new RedisStore({ url: config.redisUrl, hashSecret: config.rateLimitHashSecret })
          : undefined,
    }),
    SecurityHeadersModule.forRoot(),
    // Playground, introspection and unmasked errors follow NODE_ENV=development.
    GraphQLModule.forRootAsync({
      imports: [AuthModule],
      useFactory: () => {
        const auth = inject(AuthService);
        return {
          // The defaults, spelled out: raise them deliberately, never disable them in production.
          maxDepth: 10,
          maxComplexity: 1000,
          maxAliases: 30,
          maxQueryLength: 100 * 1024,
          maxFields: 1000,
          maxIntrospectionDepth: 20,
          parseOptions: { maxTokens: 3000 },
          // HTTP: the bearer token. Over WebSocket this runs on the upgrade request, and the
          // object onConnect returned is merged over it.
          context: (http) => ({
            currentUser: auth.fromAuthorization(http.req.headers.get('authorization')),
          }),
          subscriptions: {
            // Browsers cannot set Authorization on a WebSocket: the token is a connectionParam.
            onConnect: (_http, params) => {
              const currentUser = auth.verify(params.token);
              return currentUser ? { currentUser, sessionToken: params.token as string } : false;
            },
            // Rechecked subscriptions (commentAdded) re-verify the token with a live lookup
            // before every event, so a revoked token ends them instead of the connect-time
            // identity staying valid for the life of the socket.
            refreshContext: ({ context }) => {
              const currentUser = auth.verify(context.sessionToken);
              return currentUser ? { currentUser } : false;
            },
            allowedOrigins: config.corsOrigins,
          },
          // REDIS_PUBSUB_SIGNING_KEY signs every event, so nothing else on the Redis server
          // can inject one.
          pubsub: config.redisUrl ? new RedisPubSub(redisPubSubOptions(process.env)) : new PubSub(),
        };
      },
    }),
    BlogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
