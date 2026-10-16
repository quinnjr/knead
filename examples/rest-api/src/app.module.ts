import { inject, Module } from '@knead/core';
import { CorsModule } from '@knead/cors';
import { GraphQLModule } from '@knead/graphql';
import { RateLimitModule } from '@knead/rate-limit';
import { SecurityHeadersModule } from '@knead/security-headers';
import { AuthModule, AuthService } from './auth/auth.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    CorsModule.forRoot({ origin: ['http://localhost:5173'], credentials: true }),
    RateLimitModule.forRoot({ limit: 100, window: '1m' }),
    SecurityHeadersModule.forRoot(),
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
          context: (http) => {
            const header = http.req.headers.get('authorization');
            return {
              user: header?.startsWith('Bearer ') ? auth.verify(header.slice(7)) : undefined,
            };
          },
        };
      },
    }),
    UsersModule,
  ],
})
export class AppModule {}
