import { Module } from '@knead-js/core';
import { Controller, type Ctx, Get, Post } from '@knead-js/http';
import { RateLimit, RateLimitModule, SkipRateLimit } from '@knead-js/rate-limit';

// #region routes
@Controller('/')
export class AccountController {
  // One counter for this route: 5 attempts per client IP every 15 minutes.
  @Post('/login')
  @RateLimit({ limit: 5, window: '15m' })
  login() {
    return { token: 'issued' };
  }

  // Keyed by API key instead of IP; requests without the header share one bucket.
  @Get('/reports')
  @RateLimit({
    limit: 1000,
    window: '1h',
    key: (ctx: Ctx) => ctx.req.headers.get('x-api-key') ?? undefined,
  })
  reports() {
    return [];
  }

  @Get('/health')
  @SkipRateLimit()
  health() {
    return { ok: true };
  }

  @Get('/profile')
  profile() {
    return { name: 'Ada' };
  }
}
// #endregion routes

// #region module
@Module({
  imports: [RateLimitModule.forRoot({ limit: 100, window: '1m' })],
  controllers: [AccountController],
})
export class AppModule {}
// #endregion module
