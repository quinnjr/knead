import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@hpmws/core';
import { APP_GUARD, type Ctx } from '@hpmws/http';
import { RateLimitModule } from '@hpmws/rate-limit';
import { Int, Mutation, Query, Resolver, Subscription } from '../src/index.js';
import { originAllowed } from '../src/subscriptions.js';
import { type Started, startGraphQL, upgradeStatus } from './helpers.js';

let bumps = 0;

@Resolver()
class R {
  @Query(() => Int) n() {
    return bumps;
  }
  @Mutation(() => Int) bump() {
    return ++bumps;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

describe('WebSocket transport security', () => {
  test('queries and mutations are refused over WebSocket and never execute', async () => {
    s = await startGraphQL([M]);
    bumps = 0;
    for (const query of ['mutation { bump }', '{ n }']) {
      const sub = await s.app.graphqlSubscribe(query);
      const first = await sub.next();
      expect(first.value?.errors?.[0]).toMatchObject({
        message: 'Only subscription operations are allowed over WebSocket.',
        extensions: { code: 'BAD_USER_INPUT' },
      });
      expect((await sub.next()).done).toBe(true);
      await sub.close();
    }
    expect(bumps).toBe(0);
  });

  test('APP_GUARD guards run on the upgrade', async () => {
    s = await startGraphQL([M], {}, [
      { provide: APP_GUARD, multi: true, useValue: (ctx: Ctx) => ctx.req.headers.has('x-ok') },
    ]);
    expect(await upgradeStatus(s.app)).toBe(403);
    expect(await upgradeStatus(s.app, { 'x-ok': '1' })).toBe(101);
  });

  test('a header-authenticating APP_GUARD can let upgrades through via ctx.upgrade', async () => {
    const bearer = (ctx: Ctx) =>
      ctx.upgrade !== null || ctx.req.headers.get('authorization') === 'Bearer ok';
    s = await startGraphQL([M], {}, [{ provide: APP_GUARD, multi: true, useValue: bearer }]);
    expect(await upgradeStatus(s.app)).toBe(101);
    expect((await s.app.graphql('{ n }')).status).toBe(403);
    const ok = await s.app.graphql('{ n }', { headers: { authorization: 'Bearer ok' } });
    expect(ok.status).toBe(200);
  });

  test('cross-origin upgrades are 403 by default; no Origin header is allowed', async () => {
    s = await startGraphQL([M]);
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(s.app, { origin: `http://127.0.0.1:${s.app.url.port}` })).toBe(101);
    expect(await upgradeStatus(s.app)).toBe(101);
  });

  test('same-origin also requires the same scheme', async () => {
    s = await startGraphQL([M]);
    // The test server speaks plain HTTP, so an https:// page on the same host is another origin.
    expect(await upgradeStatus(s.app, { origin: `https://127.0.0.1:${s.app.url.port}` })).toBe(403);
  });

  test('originAllowed compares scheme and host', () => {
    expect(originAllowed('https://app.example', 'app.example', true, undefined)).toBe(true);
    expect(originAllowed('http://app.example', 'app.example', true, undefined)).toBe(false);
    expect(originAllowed('http://app.example', 'APP.example', false, undefined)).toBe(true);
    expect(originAllowed('https://app.example', 'app.example', false, undefined)).toBe(false);
    expect(originAllowed('null', 'app.example', false, undefined)).toBe(false);
    expect(originAllowed(null, 'app.example', true, undefined)).toBe(true);
  });

  test('allowedOrigins lists extra origins; "*" allows any', async () => {
    s = await startGraphQL([M], { subscriptions: { allowedOrigins: ['https://app.example'] } });
    expect(await upgradeStatus(s.app, { origin: 'https://app.example' })).toBe(101);
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(403);
    await s.mod.close();
    s = await startGraphQL([M], { subscriptions: { allowedOrigins: '*' } });
    expect(await upgradeStatus(s.app, { origin: 'https://evil.example' })).toBe(101);
  });

  test('rate limiting applies to the upgrade (429)', async () => {
    s = await startGraphQL([M, RateLimitModule.forRoot({ limit: 1, window: '1m' })]);
    expect(await upgradeStatus(s.app)).toBe(101);
    expect(await upgradeStatus(s.app)).toBe(429);
  });

  test('without subscriptions there is no endpoint: the upgrade is a plain GET (400)', async () => {
    s = await startGraphQL([M], { subscriptions: false });
    expect(await upgradeStatus(s.app)).toBe(400);
  });
});
