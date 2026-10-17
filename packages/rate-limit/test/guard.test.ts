import { afterEach, describe, expect, test } from 'bun:test';
import { APP_GUARD, Controller, type Ctx, Get, UseGuards } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import { RATE_LIMIT_META } from '../src/decorators.js';
import {
  RateLimit,
  RateLimitGuard,
  RateLimitModule,
  type RateLimitRule,
  type RateLimitStore,
} from '../src/index.js';

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

  describe('on GraphQL resolvers', () => {
    /** A MemoryStore stand-in that records every consume() call. */
    function countingStore() {
      const calls: string[] = [];
      const counts = new Map<string, number>();
      const store: RateLimitStore = {
        consume: async (key: string, rule: RateLimitRule) => {
          calls.push(key);
          const used = (counts.get(key) ?? 0) + 1;
          counts.set(key, used);
          return {
            allowed: used <= rule.limit,
            remaining: Math.max(0, rule.limit - used),
            resetAt: Date.now() + rule.windowMs,
          };
        },
      };
      return { store, calls };
    }

    /** An HTTP Ctx for one GraphQL request, and `n` ResolverCtx for one field of a list. */
    function graphqlRequest(n: number, meta: Record<PropertyKey, unknown> = {}) {
      const http = {
        req: new Request('http://localhost/graphql', { method: 'POST' }),
        ip: '203.0.113.7',
        res: { headers: new Headers() },
        state: {},
      } as unknown as Ctx;
      const fields = Array.from(
        { length: n },
        () =>
          ({
            http,
            meta,
            info: { parentType: { name: 'Book' }, fieldName: 'author' },
          }) as unknown as Ctx,
      );
      return { http, fields };
    }

    async function guard(store: RateLimitStore, limit = 5) {
      mod = await Test.createModule({
        imports: [RateLimitModule.forRoot({ limit, window: '1m', middleware: false, store })],
      }).compile();
      return mod.get(RateLimitGuard);
    }

    test('a guarded field in a 10-item list consumes once per HTTP request', async () => {
      const { store, calls } = countingStore();
      const g = await guard(store);
      const first = graphqlRequest(10);
      const results = await Promise.all(first.fields.map((ctx) => g.canActivate(ctx)));
      expect(results).toEqual(Array(10).fill(true));
      expect(calls).toEqual(['guard:global|203.0.113.7']);
      expect(first.http.res!.headers.get('ratelimit-remaining')).toBe('4');
      // Another HTTP request is counted again.
      await Promise.all(graphqlRequest(10).fields.map((ctx) => g.canActivate(ctx)));
      expect(calls).toHaveLength(2);
    });

    test('the HTTP-level guard and the field guards of one request count once', async () => {
      const { store, calls } = countingStore();
      const g = await guard(store, 1);
      const { http, fields } = graphqlRequest(3);
      expect(await g.canActivate(http)).toBe(true);
      for (const ctx of fields) expect(await g.canActivate(ctx)).toBe(true);
      expect(calls).toHaveLength(1);
    });

    test('a field with @RateLimit() keeps its own per-resolution counter', async () => {
      const { store, calls } = countingStore();
      const g = await guard(store);
      const override = { [RATE_LIMIT_META]: { limit: 20 } };
      await Promise.all(graphqlRequest(3, override).fields.map((ctx) => g.canActivate(ctx)));
      expect(calls).toEqual(Array(3).fill('guard:graphql Book.author|203.0.113.7'));
    });
  });
});
