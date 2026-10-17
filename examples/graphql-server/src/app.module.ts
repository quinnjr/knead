import { AbilityGuard, CaslModule, mapCaslError } from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { GraphQLModule, PubSub, RedisPubSub } from '@knead-js/graphql';
import { RateLimitModule, RedisStore } from '@knead-js/rate-limit';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { AccountResolver } from './auth/account.js';
import { AuthModule, AuthService, sessionContext } from './auth/auth.js';
import { caslOptions } from './auth/permissions.js';
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
    CaslModule.forRoot(caslOptions),
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
          // Every root field needs @Can() or @SkipAbility(); a missing one fails closed.
          guards: [AbilityGuard],
          // A CASL ForbiddenError thrown by resolver code is FORBIDDEN, not a masked error.
          mapError: mapCaslError,
          // HTTP: the bearer token. Over WebSocket this runs on the upgrade request, and the
          // object onConnect returned is merged over it.
          context: (http) =>
            sessionContext(auth.fromAuthorization(http.req.headers.get('authorization'))),
          subscriptions: {
            // Browsers cannot set Authorization on a WebSocket: the token is a connectionParam.
            onConnect: (_http, params) => {
              const session = auth.verify(params.token);
              return session
                ? { ...sessionContext(session), sessionToken: params.token as string }
                : false;
            },
            // Rechecked subscriptions (commentAdded) re-verify the token with a live lookup
            // before every event, so a revoked token ends them instead of the connect-time
            // identity staying valid for the life of the socket.
            refreshContext: ({ context }) => {
              const session = auth.verify(context.sessionToken);
              return session ? sessionContext(session) : false;
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
  providers: [AccountResolver],
})
export class AppModule {}
