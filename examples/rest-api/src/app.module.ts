import { inject, Module } from '@hpmws/core';
import { CorsModule } from '@hpmws/cors';
import { GraphQLModule } from '@hpmws/graphql';
import { RateLimitModule } from '@hpmws/rate-limit';
import { SecurityHeadersModule } from '@hpmws/security-headers';
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
