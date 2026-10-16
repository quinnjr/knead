import { afterEach, describe, expect, test } from 'bun:test';
import { APP_GUARD, Controller, type Ctx, Get, UseGuards } from '@knead/http';
import { Test, type TestingModule } from '@knead/testing';
import { RateLimit, RateLimitGuard, RateLimitModule } from '../src/index.js';

/** Signs the user in from a header; earlier in the guard chain than RateLimitGuard. */
const AuthGuard = (ctx: Ctx) => {
  const user = ctx.req.headers.get('x-user');
  if (user) ctx.state.account = { id: user };
  return true;
};

/** Per user when signed in, per IP otherwise. */
const userOrIp = (ctx: Ctx) => {
  const user = ctx.state.account as { id: string } | undefined;
  return user ? `user:${user.id}` : `ip:${ctx.ip}`;
};

@Controller('/g')
@UseGuards(AuthGuard, RateLimitGuard)
class GuardedController {
  @Get('/me') me() {
    return 'me';
  }
  @Get('/strict') @RateLimit({ limit: 1 }) strict() {
    return 's';
  }
}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

describe('RateLimitGuard', () => {
  test('keys on ctx.state set by an earlier guard: one budget per user', async () => {
    mod = await Test.createModule({
      imports: [
        RateLimitModule.forRoot({ limit: 2, window: '1m', key: userOrIp, middleware: false }),
      ],
      controllers: [GuardedController],
    }).compile();
    const app = await mod.createApp();
    const as = (user?: string) =>
      app.request('GET', '/g/me', { headers: user ? { 'x-user': user } : {} });
    const first = await as('ada');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect((await as('ada')).status).toBe(200);
    const limited = await as('ada');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    // Another user, and anonymous requests (keyed by IP), have their own budgets.
    expect((await as('grace')).status).toBe(200);
    expect((await as()).status).toBe(200);
  });

  test('@RateLimit() overrides apply in the guard phase too', async () => {
    mod = await Test.createModule({
      imports: [
        RateLimitModule.forRoot({ limit: 10, window: '1m', key: userOrIp, middleware: false }),
      ],
      controllers: [GuardedController],
    }).compile();
    const app = await mod.createApp();
    const headers = { 'x-user': 'ada' };
    expect((await app.request('GET', '/g/strict', { headers })).status).toBe(200);
    expect((await app.request('GET', '/g/strict', { headers })).status).toBe(429);
  });

  test('works as an APP_GUARD', async () => {
    @Controller('/a')
    class Open {
      @Get('/') open() {
        return 'o';
      }
    }
    mod = await Test.createModule({
      imports: [RateLimitModule.forRoot({ limit: 1, window: '1m', middleware: false })],
      controllers: [Open],
      providers: [{ provide: APP_GUARD, multi: true, useClass: RateLimitGuard }],
    }).compile();
    const app = await mod.createApp();
    expect((await app.request('GET', '/a')).status).toBe(200);
    expect((await app.request('GET', '/a')).status).toBe(429);
  });
});
