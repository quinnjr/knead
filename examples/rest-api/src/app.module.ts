import { AbilityGuard, CaslModule, mapCaslError } from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { GraphQLModule } from '@knead-js/graphql';
import { RateLimitModule } from '@knead-js/rate-limit';
import { ScheduleModule } from '@knead-js/schedule';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { AuthModule, AuthService } from './auth/auth.js';
import { caslOptions } from './auth/permissions.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    CorsModule.forRoot({ origin: ['http://localhost:5173'], credentials: true }),
    RateLimitModule.forRoot({ limit: 100, window: '1m' }),
    SecurityHeadersModule.forRoot(),
    CaslModule.forRoot(caslOptions),
    // Every replica runs every job; pass a RedisLockStore and `lock: true` to run a cron job once.
    ScheduleModule.forRoot(),
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
          parseOptions: { maxTokens: 10_000 },
          // Every resolver needs @Can() or @SkipAbility(); a missing one fails closed.
          guards: [AbilityGuard],
          // A CASL ForbiddenError thrown by resolver code is a FORBIDDEN error, not a masked 500.
          mapError: mapCaslError,
          context: (http) => {
            const header = http.req.headers.get('authorization');
            return {
              session: header?.startsWith('Bearer ') ? auth.verify(header.slice(7)) : undefined,
            };
          },
        };
      },
    }),
    UsersModule,
  ],
})
export class AppModule {}
