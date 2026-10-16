import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ModuleImport } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import { Controller, type Ctx, Get } from '@knead-js/http';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import type { RedisClient } from 'bun';
import {
  MemoryStore,
  RateLimit,
  RateLimitModule,
  type RateLimitModuleOptions,
  type RateLimitStore,
  RedisStore,
  SkipRateLimit,
} from '../src/index.js';

@Controller('/r')
class LimitedController {
  @Get('/global') global() {
    return 'g';
  }
  @Get('/strict') @RateLimit({ limit: 1, window: '1m' }) strict() {
    return 's';
  }
  @Get('/free') @SkipRateLimit() free() {
    return 'f';
  }
  @Get('/by-key')
  @RateLimit({ limit: 1, key: (ctx: Ctx) => ctx.req.headers.get('x-api-key') ?? undefined })
  byKey() {
    return 'k';
  }
}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function serve(
  options: Partial<RateLimitModuleOptions> = {},
  extraImports: ModuleImport[] = [],
): Promise<TestApp> {
  mod = await Test.createModule({
    imports: [...extraImports, RateLimitModule.forRoot({ limit: 2, window: '1m', ...options })],
    controllers: [LimitedController],
  }).compile();
  return mod.createApp();
}

describe('RateLimitModule', () => {
  test('global limits send RateLimit headers and 429 problem+json with Retry-After', async () => {
    const app = await serve();
    const first = await app.request('GET', '/r/global');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(Number(first.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    await app.request('GET', '/r/global');
    const third = await app.request('GET', '/r/global');
    expect(third.status).toBe(429);
    expect(third.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await third.json()) as { title: string }).title).toBe('Too Many Requests');
  });

  test('@RateLimit routes have their own counter; @SkipRateLimit is unlimited', async () => {
    const app = await serve();
    expect((await app.request('GET', '/r/strict')).status).toBe(200);
    expect((await app.request('GET', '/r/strict')).status).toBe(429);
    expect((await app.request('GET', '/r/global')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await app.request('GET', '/r/free')).status).toBe(200);
  });

  test("custom keys; with onMissingKey: 'skip', keyless requests are not limited and warn once", async () => {
    const app = await serve({ onMissingKey: 'skip' });
    const withKey = (k: string) => app.request('GET', '/r/by-key', { headers: { 'x-api-key': k } });
    expect((await withKey('a')).status).toBe(200);
    expect((await withKey('a')).status).toBe(429);
    expect((await withKey('b')).status).toBe(200);
    expect((await app.request('GET', '/r/by-key')).status).toBe(200);
    expect((await app.request('GET', '/r/by-key')).status).toBe(200);
    expect(
      mod!.logs.filter((e) => e.level === 'warn' && e.message.includes('no key')),
    ).toHaveLength(1);
  });

  test('unmatched requests count against the global limit', async () => {
    const app = await serve({ limit: 1 });
    expect((await app.request('GET', '/missing')).status).toBe(404);
    expect((await app.request('GET', '/missing')).status).toBe(429);
  });

  test('CORS headers decorate 429 responses (Review Focus 2)', async () => {
    const app = await serve({ limit: 1 }, [CorsModule.forRoot({ origin: 'https://app.example' })]);
    const headers = { origin: 'https://app.example' };
    await app.request('GET', '/r/global', { headers });
    const limited = await app.request('GET', '/r/global', { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  test('store failures fail open by default and closed with onStoreError: deny', async () => {
    const broken: RateLimitStore = { consume: async () => Promise.reject(new Error('redis down')) };
    const open = await serve({ store: broken });
    expect((await open.request('GET', '/r/global')).status).toBe(200);
    expect(mod!.logs.some((e) => e.level === 'warn' && e.message.includes('store'))).toBe(true);
    await mod!.close();
    const closed = await serve({ store: broken, onStoreError: 'deny' });
    expect((await closed.request('GET', '/r/global')).status).toBe(503);
  });

  test('a Redis client that never answers is a store error (onStoreError applies)', async () => {
    const never = { send: () => new Promise(() => {}) } as unknown as RedisClient;
    const store = new RedisStore({ client: never, commandTimeout: 20 });
    const open = await serve({ store });
    expect((await open.request('GET', '/r/global')).status).toBe(200);
    await mod!.close();
    const closed = await serve({ store, onStoreError: 'deny' });
    expect((await closed.request('GET', '/r/global')).status).toBe(503);
  });

  test('store failures are logged as a redacted summary outside development', async () => {
    const error = Object.assign(new Error('dial redis://app:pw@cache failed'), {
      command: 'AUTH app pw',
    });
    const broken: RateLimitStore = { consume: async () => Promise.reject(error) };
    mod = await Test.createModule({
      imports: [RateLimitModule.forRoot({ limit: 2, window: '1m', store: broken })],
      controllers: [LimitedController],
    }).compile({ development: false });
    const app = await mod.createApp();
    expect((await app.request('GET', '/r/global')).status).toBe(200);
    const entry = mod.logs.find((e) => e.message.includes('Rate limit store failed'))!;
    expect(entry.level).toBe('warn');
    expect(entry.message).toContain('Error: dial redis://***@cache failed');
    expect(entry.message).toMatch(/correlation id [0-9a-f-]{36}/);
    expect(entry.meta).toEqual([]);
  });

  test('parallel requests never exceed the limit', async () => {
    const app = await serve({ limit: 5 });
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => app.request('GET', '/r/global').then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
  });

  test('the store is closed on shutdown', async () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    const realClose = store.close.bind(store);
    const close = mock(() => realClose());
    store.close = close;
    await serve({ store });
    await mod!.close();
    mod = undefined;
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('invalid options are rejected at forRoot', () => {
    expect(() => RateLimitModule.forRoot({ limit: 0, window: '1m' })).toThrow(RangeError);
    expect(() => RateLimitModule.forRoot({ limit: 1, window: 'soon' as never })).toThrow(
      RangeError,
    );
  });

  test('@RateLimit rejects invalid options at decoration time', () => {
    expect(() => RateLimit({ limit: 0 })).toThrow(RangeError);
    expect(() => RateLimit({ limit: 1.5 })).toThrow(RangeError);
    expect(() => RateLimit({ window: 'soon' as never })).toThrow(RangeError);
    expect(() => RateLimit({ window: -5 })).toThrow(RangeError);
    expect(() => RateLimit({ key: () => 'k' })).not.toThrow();
  });
});
