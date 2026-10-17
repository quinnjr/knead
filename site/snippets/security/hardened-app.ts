import { Module } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { Controller, Get, Post } from '@knead-js/http';
import { RateLimit, RateLimitModule, SkipRateLimit } from '@knead-js/rate-limit';
import { SecurityHeadersModule } from '@knead-js/security-headers';

// #region module
@Controller('/')
export class ApiController {
  @Get('/health')
  @SkipRateLimit()
  health() {
    return { ok: true };
  }

  @Post('/login')
  @RateLimit({ limit: 5, window: '15m' })
  login() {
    return { token: 'issued' };
  }

  @Get('/me')
  me() {
    return { name: 'Ada' };
  }
}

@Module({
  imports: [
    // Priority 1100: outermost, so every response below carries the headers.
    SecurityHeadersModule.forRoot(),
    // Priority 1000: answers preflights before rate limiting and routing.
    CorsModule.forRoot({
      origin: ['https://app.example.com'],
      credentials: true,
      exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
    // Priority 900: counts every request that is not a preflight.
    RateLimitModule.forRoot({ limit: 300, window: '1m' }),
  ],
  controllers: [ApiController],
})
export class AppModule {}
// #endregion module
