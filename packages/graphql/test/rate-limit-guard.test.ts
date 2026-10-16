import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { UseGuards } from '@hpmws/http';
import { RateLimit, RateLimitGuard, RateLimitModule } from '@hpmws/rate-limit';
import { Int, Query, Resolver } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

@Resolver()
class Limited {
  @Query(() => Int)
  @UseGuards(RateLimitGuard)
  limited() {
    return 1;
  }
  @Query(() => Int)
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 2 })
  roomier() {
    return 2;
  }
}

@Module({ providers: [Limited] })
class LimitedModule {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('RateLimitGuard on GraphQL resolvers', () => {
  test('keys on ctx.http.ip, sets headers on the HTTP response, and limits per resolver', async () => {
    s = await startGraphQL([
      LimitedModule,
      RateLimitModule.forRoot({ limit: 1, window: '1m', middleware: false }),
    ]);
    const first = await s.app.graphql('{ limited }');
    expect(first.data).toEqual({ limited: 1 });
    expect(first.headers.get('ratelimit-limit')).toBe('1');
    const second = await s.app.graphql('{ limited }');
    expect(second.errors?.[0]?.extensions?.code).toBe('RATE_LIMITED');
    // @RateLimit() on the resolver is its own counter.
    expect((await s.app.graphql('{ roomier }')).data).toEqual({ roomier: 2 });
    expect((await s.app.graphql('{ roomier }')).data).toEqual({ roomier: 2 });
    expect((await s.app.graphql('{ roomier }')).errors?.[0]?.extensions?.code).toBe('RATE_LIMITED');
  });
});
