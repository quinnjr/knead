import { Module } from '@knead-js/core';
import { Controller, type Ctx, Get, type Guard, UseGuards } from '@knead-js/http';
import { RateLimitGuard, RateLimitModule } from '@knead-js/rate-limit';

const apiKeys = new Map([
  ['key-ada', 'acct_ada'],
  ['key-grace', 'acct_grace'],
]);

// #region guard
/** Resolves the caller's account from its API key and stores it for later guards. */
export class ApiKeyGuard implements Guard {
  canActivate(ctx: Ctx): boolean {
    const account = apiKeys.get(ctx.req.headers.get('x-api-key') ?? '');
    if (account === undefined) return false;
    ctx.state.accountId = account;
    return true;
  }
}

@Controller('/usage')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class UsageController {
  @Get('/')
  usage() {
    return { calls: 42 };
  }
}

@Module({
  imports: [
    RateLimitModule.forRoot({
      limit: 1000,
      window: '1h',
      // Only the guard counts; the global middleware is not installed.
      middleware: false,
      // Runs after ApiKeyGuard, so the account is known.
      key: (ctx) => {
        const account = ctx.state.accountId;
        return typeof account === 'string' ? account : ctx.ip;
      },
    }),
  ],
  controllers: [UsageController],
})
export class AppModule {}
// #endregion guard
