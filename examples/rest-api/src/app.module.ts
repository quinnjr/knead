import { Module } from '@hpmws/core';
import { CorsModule } from '@hpmws/cors';
import { RateLimitModule } from '@hpmws/rate-limit';
import { SecurityHeadersModule } from '@hpmws/security-headers';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    CorsModule.forRoot({ origin: ['http://localhost:5173'], credentials: true }),
    RateLimitModule.forRoot({ limit: 100, window: '1m' }),
    SecurityHeadersModule.forRoot(),
    UsersModule,
  ],
})
export class AppModule {}
