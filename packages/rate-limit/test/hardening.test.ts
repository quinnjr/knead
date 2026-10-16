import { afterEach, describe, expect, test } from 'bun:test';
import { Controller, type Ctx, Get } from '@hpmws/http';
import { Test, type TestApp, type TestingModule } from '@hpmws/testing';
import {
  hashKey,
  MemoryStore,
  maskIp,
  parseDuration,
  RateLimit,
  RateLimitModule,
  type RateLimitModuleOptions,
} from '../src/index.js';

@Controller('/h')
class HardeningController {
  @Get('/global') global() {
    return 'g';
  }
  @Get('/keyed')
  @RateLimit({ limit: 1, key: (ctx: Ctx) => ctx.req.headers.get('x-api-key') ?? undefined })
  keyed() {
    return 'k';
  }
}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function serve(options: Partial<RateLimitModuleOptions> = {}): Promise<TestApp> {
  mod = await Test.createModule({
    imports: [RateLimitModule.forRoot({ limit: 1, window: '1m', ...options })],
    controllers: [HardeningController],
  }).compile();
  // One trusted proxy hop: X-Forwarded-For picks the client address.
  return mod.createApp({ trustProxy: 1 });
}

const from = (app: TestApp, ip: string, path = '/h/global') =>
  app.request('GET', path, { headers: { 'x-forwarded-for': ip } });

describe('IPv6 subnets', () => {
  test('maskIp keeps IPv4 and masks IPv6 to the prefix', () => {
    expect(maskIp('203.0.113.9', 64)).toBe('203.0.113.9');
    expect(maskIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 64)).toBe('2001:db8:1:2::/64');
    expect(maskIp('2001:db8:1:2:aaaa::1', 48)).toBe('2001:db8:1::/48');
    expect(maskIp('2001:db8::1', 128)).toBe('2001:db8::1/128');
    expect(maskIp('not-an-ip', 64)).toBe('not-an-ip');
  });

  test('by default, every address in one IPv6 /64 shares a bucket', async () => {
    const app = await serve();
    expect((await from(app, '2001:db8:1:2::1')).status).toBe(200);
    expect((await from(app, '2001:db8:1:2:ffff::9')).status).toBe(429);
    expect((await from(app, '2001:db8:1:3::1')).status).toBe(200);
    expect((await from(app, '203.0.113.1')).status).toBe(200);
    expect((await from(app, '203.0.113.2')).status).toBe(200);
  });

  test('ipv6Subnet: 128 keys each address separately', async () => {
    const app = await serve({ ipv6Subnet: 128 });
    expect((await from(app, '2001:db8:1:2::1')).status).toBe(200);
    expect((await from(app, '2001:db8:1:2::2')).status).toBe(200);
  });

  test('invalid ipv6Subnet values are rejected at forRoot', () => {
    for (const ipv6Subnet of [-1, 129, 1.5, Number.NaN]) {
      expect(() => RateLimitModule.forRoot({ limit: 1, window: '1m', ipv6Subnet })).toThrow(
        RangeError,
      );
    }
    expect(() => RateLimitModule.forRoot({ limit: 1, window: '1m', ipv6Subnet: 0 })).not.toThrow();
  });
});

describe('hashed store keys', () => {
  test('hashKey is a 32-character SHA-256 hex prefix', () => {
    const expected = new Bun.CryptoHasher('sha256').update('global|1.2.3.4').digest('hex');
    expect(hashKey('global|1.2.3.4')).toBe(expected.slice(0, 32));
    expect(hashKey('a')).not.toBe(hashKey('b'));
  });

  test('MemoryStore limits the same with and without hashing', async () => {
    const rule = { limit: 1, windowMs: 60_000, algorithm: 'sliding-window' } as const;
    for (const hashKeys of [true, false]) {
      const store = new MemoryStore({ hashKeys, sweepIntervalMs: 0 });
      expect((await store.consume('a'.repeat(10_000), rule)).allowed).toBe(true);
      expect((await store.consume('a'.repeat(10_000), rule)).allowed).toBe(false);
      expect((await store.consume('b', rule)).allowed).toBe(true);
    }
  });
});

describe('requests without a key', () => {
  const keyless = (app: TestApp) => app.request('GET', '/h/keyed');

  test("default 'shared': keyless requests share one anonymous bucket per scope", async () => {
    const app = await serve();
    expect((await keyless(app)).status).toBe(200);
    expect((await keyless(app)).status).toBe(429);
    const keyed = await app.request('GET', '/h/keyed', { headers: { 'x-api-key': 'k' } });
    expect(keyed.status).toBe(200);
    expect(
      mod!.logs.filter((e) => e.level === 'warn' && e.message.includes('no key')),
    ).toHaveLength(1);
  });

  test("'skip' lets keyless requests through unlimited", async () => {
    const app = await serve({ onMissingKey: 'skip' });
    for (let i = 0; i < 3; i++) expect((await keyless(app)).status).toBe(200);
  });

  test("'deny' rejects keyless requests with 403", async () => {
    const app = await serve({ onMissingKey: 'deny' });
    expect((await keyless(app)).status).toBe(403);
  });

  test('an unknown onMissingKey is rejected at forRoot', () => {
    expect(() =>
      RateLimitModule.forRoot({ limit: 1, window: '1m', onMissingKey: 'maybe' as never }),
    ).toThrow(RangeError);
  });
});

describe('duration cap', () => {
  test('durations above one year are configuration errors', () => {
    expect(parseDuration('365d')).toBe(31_536_000_000);
    expect(() => parseDuration('366d')).toThrow(RangeError);
    expect(() => parseDuration(31_536_000_001)).toThrow(RangeError);
    expect(() => parseDuration('1e9d' as never)).toThrow(RangeError);
    expect(() => RateLimit({ window: '400d' })).toThrow(RangeError);
    expect(() => RateLimitModule.forRoot({ limit: 1, window: '9000h' })).toThrow(RangeError);
  });
});
