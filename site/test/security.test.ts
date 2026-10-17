import { afterEach, describe, expect, test } from 'bun:test';
import { Module, type ModuleImport } from '@knead-js/core';
import {
  CorsConfigError,
  CorsModule,
  MAX_ORIGIN_LENGTH,
  mergeVary,
  validateCorsOptions,
} from '@knead-js/cors';
import {
  Controller,
  type Ctx,
  Get,
  HttpConfigError,
  type ListenOptions,
  MemoryLogger,
  Post,
  UseGuards,
} from '@knead-js/http';
import {
  hashKey,
  MAX_DURATION_MS,
  MemoryStore,
  maskIp,
  parseDuration,
  RateLimit,
  RateLimitModule,
  type RateLimitStore,
  RedisStore,
  validateRateLimitOptions,
} from '@knead-js/rate-limit';
import { POLICIES, sanitize, sanitizedHtml } from '@knead-js/sanitize';
import {
  buildHeaders,
  DEFAULT_CSP_DIRECTIVES,
  DEFAULT_OPTIONS,
  generateNonce,
  MIN_RECOMMENDED_HSTS_MAX_AGE,
  mergeOptions,
  nonceTargets,
  SecurityHeaders,
  SecurityHeadersModule,
  type SecurityHeadersOptions,
  serializeCsp,
  validateSecurityHeadersOptions,
} from '@knead-js/security-headers';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';
import * as v from 'valibot';
import * as corsSnippet from '../snippets/security/cors.js';
import * as hardened from '../snippets/security/hardened-app.js';
import * as rateLimitSnippet from '../snippets/security/rate-limit.js';
import * as rateLimitGuardSnippet from '../snippets/security/rate-limit-guard.js';
import { rateLimitModule } from '../snippets/security/redis-store.js';
import * as sanitizeSnippet from '../snippets/security/sanitize.js';
import * as headersSnippet from '../snippets/security/security-headers.js';
import * as defaultsSnippet from '../snippets/security/security-headers-defaults.js';

const open: TestingModule[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
});

async function serve(
  imports: ModuleImport[],
  options: { development?: boolean } & ListenOptions = {},
): Promise<{ app: TestApp; mod: TestingModule }> {
  const { development = true, ...listen } = options;
  const mod = await Test.createModule({ imports }).compile({ development });
  open.push(mod);
  const app = await mod.createApp(listen);
  return { app, mod };
}

const preflight = (origin: string, extra: Record<string, string> = {}) => ({
  headers: { origin, 'access-control-request-method': 'POST', ...extra },
});

describe('security: cors', () => {
  const corsApp = (options: Parameters<typeof CorsModule.forRoot>[0]) => {
    @Module({
      imports: [CorsModule.forRoot(options)],
      controllers: [corsSnippet.ProjectsController],
    })
    class App {}
    return serve([App]);
  };

  test('allowed origins get the exact origin, credentials, exposed headers and Vary', async () => {
    const { app } = await serve([corsSnippet.AppModule]);
    const res = await app.request('GET', '/api/projects', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After',
    );
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('disallowed origins still run, without CORS headers', async () => {
    const { app } = await serve([corsSnippet.AppModule]);
    const res = await app.request('GET', '/api/projects', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('allowed preflight: 204 with default methods, reflected headers and max-age', async () => {
    const { app } = await serve([corsSnippet.AppModule]);
    const res = await app.request(
      'OPTIONS',
      '/api/projects',
      preflight('https://admin.example.com', { 'access-control-request-headers': 'content-type' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, PUT, PATCH, POST, DELETE',
    );
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('vary')).toBe('Origin, Access-Control-Request-Headers');
  });

  test('disallowed preflight is a 204 without CORS headers, also on unrouted paths', async () => {
    const { app } = await serve([corsSnippet.AppModule]);
    const res = await app.request('OPTIONS', '/nowhere', preflight('https://evil.example'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  test('a RegExp origin matches only what it anchors', async () => {
    const { app } = await corsApp(corsSnippet.previewCors);
    const acao = async (origin: string) =>
      (await app.request('GET', '/api/projects', { headers: { origin } })).headers.get(
        'access-control-allow-origin',
      );
    expect(await acao('https://pr-12.preview.example.com')).toBe(
      'https://pr-12.preview.example.com',
    );
    expect(await acao('https://preview.example.com')).toBe('https://preview.example.com');
    expect(await acao('https://preview.example.com.evil')).toBeNull();
  });

  test('a predicate receives the context; configured headers and methods are used verbatim', async () => {
    const { app } = await corsApp(corsSnippet.tenantCors);
    // A browser-shaped preflight: browsers never send author headers such as x-tenant on it.
    const ok = await app.request(
      'OPTIONS',
      '/api/projects',
      preflight('https://acme.example.com', { 'access-control-request-headers': 'x-tenant' }),
    );
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://acme.example.com');
    expect(ok.headers.get('access-control-allow-headers')).toBe(
      'content-type, authorization, x-tenant',
    );
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(ok.headers.get('vary')).toBe('Origin');
    const unknown = await app.request(
      'OPTIONS',
      '/api/projects',
      preflight('https://evil.example', { 'access-control-request-headers': 'x-tenant' }),
    );
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull();
    const withHeader = await app.request('GET', '/api/projects', {
      headers: { origin: 'https://acme.example.com', 'x-tenant': 'acme' },
    });
    expect(withHeader.headers.get('access-control-allow-origin')).toBe('https://acme.example.com');
    const noHeader = await app.request('GET', '/api/projects', {
      headers: { origin: 'https://acme.example.com' },
    });
    expect(noHeader.headers.get('access-control-allow-origin')).toBeNull();
    expect(noHeader.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test("origin '*' sends * without Vary, and never answers an oversized Origin", async () => {
    const { app } = await corsApp({ origin: '*' });
    const res = await app.request('GET', '/api/projects', {
      headers: { origin: 'https://any.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toBeNull();
    const long = `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example`;
    const big = await app.request('GET', '/api/projects', { headers: { origin: long } });
    expect(big.headers.get('access-control-allow-origin')).toBeNull();
    expect(MAX_ORIGIN_LENGTH).toBe(2048);
  });

  test('configuration errors are CorsConfigError at forRoot()', () => {
    expect(() => CorsModule.forRoot({ origin: '*', credentials: true })).toThrow(CorsConfigError);
    expect(() => validateCorsOptions({ origin: ['https://a.example', '*'] })).toThrow(
      "Use origin: '*' instead of listing '*' among origins.",
    );
    expect(() => validateCorsOptions({ origin: /app\.example/ })).toThrow('must be anchored');
    expect(() =>
      validateCorsOptions({ origin: /^https:\/\/a\.example|https:\/\/b\.example$/ }),
    ).toThrow('top-level |');
    expect(() =>
      validateCorsOptions({ origin: /^(?:https:\/\/a\.example|https:\/\/b\.example)$/ }),
    ).not.toThrow();
    expect(() => validateCorsOptions({ origin: 'https://a.example', maxAge: -1 })).toThrow(
      'CORS maxAge must be a non-negative integer, got -1',
    );
    expect(() => validateCorsOptions({ origin: 'https://a.example', maxAge: 1.5 })).toThrow(
      CorsConfigError,
    );
  });

  test('mergeVary keeps existing values and adds new ones case-insensitively', () => {
    const res = new Response(null, { headers: { vary: 'Accept-Encoding, origin' } });
    expect(mergeVary(res, ['Origin', 'Accept-Language']).headers.get('vary')).toBe(
      'Accept-Encoding, origin, Accept-Language',
    );
  });
});

describe('security: security-headers', () => {
  test('a header value with a line break is a startup error that names the header', () => {
    expect(() =>
      SecurityHeadersModule.forRoot({ referrerPolicy: 'no-referrer\r\nX-Injected: 1' }),
    ).toThrow('Invalid Referrer-Policy: "no-referrer\\r\\nX-Injected: 1"');
    expect(() => validateSecurityHeadersOptions({ referrerPolicy: 'no-referrer' })).not.toThrow();
  });

  test('defaults on plain HTTP: every header but HSTS', async () => {
    const { app } = await serve([defaultsSnippet.AppModule]);
    const res = await app.request('GET', '/status');
    const h = res.headers;
    expect(h.get('content-security-policy')).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
    );
    expect(h.get('strict-transport-security')).toBeNull();
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-dns-prefetch-control')).toBe('off');
    expect(h.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    );
    expect(h.get('x-permitted-cross-domain-policies')).toBe('none');
    const missing = await app.request('GET', '/missing');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-frame-options')).toBe('DENY');
  });

  test('HSTS is sent once a trusted proxy reports HTTPS', async () => {
    const { app } = await serve([defaultsSnippet.AppModule], { trustProxy: 1 });
    const res = await app.request('GET', '/status', {
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
    });
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  test('nonces are per request and land in the CSP and ctx.state.cspNonce', async () => {
    const { app } = await serve([headersSnippet.AppModule], { trustProxy: 1 });
    const read = async () => {
      const res = await app.request('GET', '/', {
        headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
      });
      const csp = res.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      return { res, csp, nonce, body: await res.text() };
    };
    const a = await read();
    const b = await read();
    expect(a.nonce).toBeDefined();
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.body).toContain(`nonce="${a.nonce}"`);
    expect(a.csp).toBe(
      `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; img-src 'self' https://cdn.example.com; connect-src 'self' https://api.example.com; script-src 'self' 'nonce-${a.nonce}'`,
    );
    expect(a.res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  test('@SecurityHeaders() merges a route override over the module options', async () => {
    const { app } = await serve([headersSnippet.AppModule]);
    const res = await app.request('GET', '/widget');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://partner.example.com;');
    expect(csp).toContain('img-src');
    expect(csp).toContain("'nonce-");
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a method override replaces a controller override (they do not stack)', async () => {
    @Controller('/c')
    @SecurityHeaders({ referrerPolicy: 'same-origin' })
    class C {
      @Get('/a')
      @SecurityHeaders({ xFrameOptions: 'SAMEORIGIN' })
      a() {
        return 'a';
      }
      @Get('/b')
      b() {
        return 'b';
      }
    }
    @Module({ imports: [SecurityHeadersModule.forRoot()], controllers: [C] })
    class App {}
    const { app } = await serve([App]);
    const a = await app.request('GET', '/c/a');
    expect(a.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(a.headers.get('referrer-policy')).toBe('no-referrer');
    const b = await app.request('GET', '/c/b');
    expect(b.headers.get('referrer-policy')).toBe('same-origin');
  });

  test('headers the handler set are kept', async () => {
    @Controller('/')
    class C {
      @Get('/own')
      own() {
        return new Response('x', { headers: { 'x-frame-options': 'SAMEORIGIN' } });
      }
    }
    @Module({ imports: [SecurityHeadersModule.forRoot()], controllers: [C] })
    class App {}
    const { app } = await serve([App]);
    const res = await app.request('GET', '/own');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  test('a short HSTS max-age logs one warning', async () => {
    const { app, mod } = await serve([
      SecurityHeadersModule.forRoot({ strictTransportSecurity: { maxAge: 86_400 } }),
    ]);
    await app.request('GET', '/');
    const warnings = mod.logs.filter((e) => e.level === 'warn' && e.message.includes('HSTS'));
    expect(warnings).toHaveLength(1);
    expect(MIN_RECOMMENDED_HSTS_MAX_AGE).toBe(15_552_000);
  });

  test('serializeCsp, nonceTargets, buildHeaders and mergeOptions', () => {
    expect(
      serializeCsp({
        'default-src': "'self'  https:",
        'object-src': false,
        'block-all-mixed-content': true,
      }),
    ).toBe("default-src 'self' https:; block-all-mixed-content");
    expect(serializeCsp({ 'default-src': ["'self'"] }, 'abc')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc'",
    );
    expect(serializeCsp({}, 'abc', { scripts: true, styles: true })).toBe(
      "script-src 'nonce-abc'; style-src 'nonce-abc'",
    );
    expect(nonceTargets({ nonce: true })).toEqual({ scripts: true, styles: false });
    expect(nonceTargets({ nonce: { styles: true } })).toEqual({ scripts: true, styles: true });
    expect(nonceTargets({})).toBeUndefined();
    expect(nonceTargets(false)).toBeUndefined();
    const merged = mergeOptions(DEFAULT_OPTIONS, {
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': false },
        reportOnly: true,
      },
      xDnsPrefetchControl: false,
    });
    const headers = new Map(buildHeaders(merged, { secure: true }));
    expect(headers.get('content-security-policy-report-only')).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(headers.has('content-security-policy')).toBe(false);
    expect(headers.has('x-dns-prefetch-control')).toBe(false);
    expect(headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(DEFAULT_CSP_DIRECTIVES['upgrade-insecure-requests']).toBe(true);
    expect(Buffer.from(generateNonce(), 'base64')).toHaveLength(16);
  });

  test('invalid options are HttpConfigError', () => {
    const bad: SecurityHeadersOptions[] = [
      { contentSecurityPolicy: { directives: { 'Script-Src': ["'self'"] } } },
      { contentSecurityPolicy: { directives: { 'script-src': ["'self'; img-src *"] } } },
      { contentSecurityPolicy: { directives: { 'script-src': ["'self' https:"] } } },
      { strictTransportSecurity: { maxAge: -1 } },
      { strictTransportSecurity: { preload: true, includeSubDomains: false } },
      { strictTransportSecurity: { preload: true, maxAge: 15_552_000 } },
      { permissionsPolicy: 'camera=()\r\nx-injected: 1' },
    ];
    for (const options of bad) {
      expect(() => validateSecurityHeadersOptions(options)).toThrow(HttpConfigError);
    }
    expect(() =>
      validateSecurityHeadersOptions({
        contentSecurityPolicy: { directives: { 'script-src': "'self' https:" } },
      }),
    ).not.toThrow();
    expect(() => SecurityHeaders({ strictTransportSecurity: { maxAge: 1.5 } })).toThrow(
      HttpConfigError,
    );
  });
});

describe('security: rate-limit', () => {
  test('unknown onStoreError and algorithm values are rejected at forRoot', () => {
    expect(() =>
      RateLimitModule.forRoot({ limit: 5, window: '1m', onStoreError: 'deny ' as never }),
    ).toThrow(RangeError);
    expect(() =>
      RateLimitModule.forRoot({ limit: 5, window: '1m', algorithm: 'leaky-bucket' as never }),
    ).toThrow(RangeError);
  });

  test('global limit headers; @SkipRateLimit sends none', async () => {
    const { app } = await serve([rateLimitSnippet.AppModule]);
    const res = await app.request('GET', '/profile');
    expect(res.headers.get('ratelimit-limit')).toBe('100');
    expect(res.headers.get('ratelimit-remaining')).toBe('99');
    expect(Number(res.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    const health = await app.request('GET', '/health');
    expect(health.headers.get('ratelimit-limit')).toBeNull();
  });

  test('a @RateLimit route has its own counter and answers 429 problem+json', async () => {
    const { app } = await serve([rateLimitSnippet.AppModule], { development: false });
    for (let i = 0; i < 5; i++) expect((await app.request('POST', '/login')).status).toBe(200);
    const res = await app.request('POST', '/login');
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('ratelimit-limit')).toBe('5');
    expect(res.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Rate limit exceeded',
      instance: '/login',
    });
    // The global counter is separate.
    expect((await app.request('GET', '/profile')).headers.get('ratelimit-remaining')).toBe('99');
  });

  test('a custom key separates clients by API key', async () => {
    const { app } = await serve([rateLimitSnippet.AppModule]);
    const a = await app.request('GET', '/reports', { headers: { 'x-api-key': 'a' } });
    const b = await app.request('GET', '/reports', { headers: { 'x-api-key': 'b' } });
    expect(a.headers.get('ratelimit-remaining')).toBe('999');
    expect(b.headers.get('ratelimit-remaining')).toBe('999');
  });

  test('RateLimitGuard keys on what an earlier guard set', async () => {
    const { app } = await serve([rateLimitGuardSnippet.AppModule]);
    const call = (key: string) => app.request('GET', '/usage', { headers: { 'x-api-key': key } });
    expect((await call('key-ada')).headers.get('ratelimit-remaining')).toBe('999');
    expect((await call('key-ada')).headers.get('ratelimit-remaining')).toBe('998');
    expect((await call('key-grace')).headers.get('ratelimit-remaining')).toBe('999');
    expect((await call('nope')).status).toBe(403);
  });

  test('parseDuration and MAX_DURATION_MS', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('15s')).toBe(15_000);
    expect(parseDuration('1.5m')).toBe(90_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration(0.2)).toBe(1);
    expect(MAX_DURATION_MS).toBe(365 * 86_400_000);
    expect(() => parseDuration('366d')).toThrow(RangeError);
    expect(() => parseDuration('1w')).toThrow(RangeError);
    expect(() => parseDuration(0)).toThrow(RangeError);
  });

  test('validateRateLimitOptions', () => {
    expect(() => validateRateLimitOptions({ limit: 0, window: '1m' })).toThrow(RangeError);
    expect(() => validateRateLimitOptions({ limit: 1, window: '1m', ipv6Subnet: 0 })).toThrow(
      'ipv6Subnet must be an integer from 1 to 128, got 0.',
    );
    expect(() =>
      validateRateLimitOptions({ limit: 1, window: '1m', ipv6Subnet: 48 }),
    ).not.toThrow();
  });

  test('maskIp and hashKey', () => {
    expect(maskIp('203.0.113.7', 64)).toBe('203.0.113.7');
    expect(maskIp('::ffff:203.0.113.7', 64)).toBe('203.0.113.7');
    expect(maskIp('2001:db8:1:2:3:4:5:6', 64)).toBe('2001:db8:1:2::/64');
    expect(maskIp('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1::/48');
    expect(hashKey('203.0.113.7')).toHaveLength(32);
    expect(hashKey('203.0.113.7', 'k'.repeat(32))).not.toBe(hashKey('203.0.113.7'));
  });

  test('MemoryStore: sliding window and token bucket', async () => {
    let now = 60_000;
    const store = new MemoryStore({ now: () => now, sweepIntervalMs: 0 });
    const sliding = { limit: 2, windowMs: 60_000, algorithm: 'sliding-window' as const };
    expect(await store.consume('k', sliding)).toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 120_000,
    });
    expect(await store.consume('k', sliding)).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 120_000,
    });
    expect((await store.consume('k', sliding)).allowed).toBe(false);
    const bucket = { limit: 2, windowMs: 60_000, algorithm: 'token-bucket' as const };
    expect(await store.consume('b', bucket)).toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 90_000,
    });
    await store.consume('b', bucket);
    expect(await store.consume('b', bucket)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 90_000,
    });
    now += 30_000;
    expect((await store.consume('b', bucket)).allowed).toBe(true);
    expect(store.size).toBe(2);
    expect(() => new MemoryStore({ maxKeys: 0 })).toThrow(RangeError);
    store.close();
  });

  test('RedisStore refuses plaintext remote URLs with requireTls', () => {
    expect(() => rateLimitModule({ RATE_LIMIT_REDIS_URL: 'redis://redis.internal:6379' })).toThrow(
      HttpConfigError,
    );
    expect(
      () =>
        new RedisStore({ url: 'redis://localhost:6379', requireTls: true, hashSecret: 'short' }),
    ).toThrow('hashSecret must be at least 32 bytes.');
    expect(() => new RedisStore({ url: 'redis://localhost:6379', commandTimeout: 0 })).toThrow(
      RangeError,
    );
  });

  test('a plaintext remote URL without requireTls only warns', () => {
    const logger = new MemoryLogger();
    const store = new RedisStore({
      url: 'redis://redis.internal:6379',
      hashSecret: 's'.repeat(32),
      logger,
    });
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('plaintext'))).toBe(
      true,
    );
    return store.close();
  });
});

describe('security: hardened app', () => {
  test('preflights skip rate limiting; 429s carry CORS and security headers', async () => {
    const { app } = await serve([hardened.AppModule]);
    const pre = await app.request('OPTIONS', '/login', preflight('https://app.example.com'));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('ratelimit-limit')).toBeNull();
    expect(pre.headers.get('x-frame-options')).toBe('DENY');
    const headers = { origin: 'https://app.example.com' };
    for (let i = 0; i < 5; i++) await app.request('POST', '/login', { headers });
    const limited = await app.request('POST', '/login', { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(limited.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await app.request('GET', '/health')).headers.get('ratelimit-limit')).toBeNull();
  });

  test('production 500s hide details and carry a correlation id', async () => {
    @Controller('/')
    class C {
      @Get('/boom')
      boom(): never {
        throw new Error('postgres://admin:hunter2@db failed');
      }
    }
    @Module({ controllers: [C] })
    class App {}
    const { app, mod } = await serve([App], { development: false });
    const res = await app.request('GET', '/boom');
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(Object.keys(body).sort()).toEqual([
      'correlationId',
      'instance',
      'status',
      'title',
      'type',
    ]);
    expect(JSON.stringify(mod.logs)).not.toContain('hunter2');
  });

  test('prototype-polluting keys are dropped from query strings and JSON bodies', async () => {
    @Controller('/')
    class C {
      @Get('/q')
      q(ctx: Ctx) {
        return { keys: Object.keys(ctx.query) };
      }

      @Post('/j')
      async j(ctx: Ctx) {
        const body = (await ctx.json()) as Record<string, Record<string, unknown>>;
        const target = Object.assign({}, body);
        return {
          keys: Object.keys(body),
          nested: Object.keys(body.nested ?? {}),
          polluted: Object.getPrototypeOf(target) !== Object.prototype,
          ctor: body.ctor,
        };
      }
    }
    @Module({ controllers: [C] })
    class App {}
    const { app } = await serve([App]);
    const res = await app.request('GET', '/q?__proto__=x&constructor=y&prototype=w&name=z');
    expect(await res.json()).toEqual({ keys: ['name'] });
    const json = await app.request('POST', '/j', {
      headers: { 'content-type': 'application/json' },
      // The second key spells __proto__ with \u escapes, which the filter decodes too.
      body: '{"__proto__":{"admin":true},"\\u005f\\u005fproto\\u005f\\u005f":{"admin":true},"constructor":{"prototype":{"admin":true}},"prototype":{"a":1},"name":"z","nested":{"__proto__":{"admin":true},"ok":1},"ctor":{"constructor":"kept"}}',
    });
    expect(await json.json()).toEqual({
      keys: ['name', 'nested', 'ctor'],
      nested: ['ok'],
      polluted: false,
      ctor: { constructor: 'kept' },
    });
  });
});

describe('security: sanitize', () => {
  test('sanitize() with presets and a custom policy', () => {
    expect(sanitizeSnippet.preview).toBe('<p>Hi <b>there</b></p>');
    expect(sanitizeSnippet.plain).toBe('Hi there');
    expect(sanitizeSnippet.comment).toBe(
      '<a title="Docs" rel="noopener noreferrer">docs</a> <a href="https://example.com" rel="noopener noreferrer">docs</a>',
    );
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer">x</a>',
    );
    expect(
      sanitize('<img src="https://x.example/a.png" alt="a"><img alt="b"><h1>T</h1>', 'rich'),
    ).toBe('<img src="https://x.example/a.png" alt="a" /><h1>T</h1>');
    expect(sanitize('<img src="https://x.example/a.png"><h1>T</h1>', 'basic')).toBe('T');
    expect(Object.isFrozen(POLICIES.basic.allowedTags)).toBe(true);
  });

  test('unsafe policies throw TypeError', () => {
    const policy = (p: Partial<typeof POLICIES.basic> & Record<string, unknown>) => ({
      allowedTags: [],
      allowedAttributes: {},
      ...p,
    });
    expect(() => sanitize('x', policy({ allowedTags: ['SCRIPT'] }))).toThrow(TypeError);
    expect(() => sanitize('x', policy({ allowedAttributes: { a: ['onclick'] } }))).toThrow(
      TypeError,
    );
    expect(() => sanitize('x', policy({ allowedAttributes: { a: ['*'] } }))).toThrow(TypeError);
    expect(() => sanitize('x', policy({ allowedAttributes: { a: ['id'] } }))).toThrow(TypeError);
    expect(() =>
      sanitize('x', policy({ allowedAttributes: { a: ['id'] }, allowClobberingAttributes: true })),
    ).not.toThrow();
    expect(() => sanitize('x', policy({ extraSchemes: ['data'] }))).toThrow(TypeError);
    expect(() => sanitize('x', policy({ allowedSchemes: ['ftp'] }))).toThrow(TypeError);
    expect(() => sanitizedHtml(v.string(), policy({ allowedTags: ['iframe'] }))).toThrow(TypeError);
  });

  test('sanitizedHtml() as a route body schema', async () => {
    const { app } = await serve([sanitizeSnippet.AppModule]);
    const notes = await app.request('POST', '/notes', {
      headers: { 'content-type': 'text/plain' },
      body: '<h2>Plan</h2><img src="javascript:x"><script>x()</script>',
    });
    expect(await notes.json()).toEqual({ html: '<h2>Plan</h2>' });
    const posts = await app.request('POST', '/posts', {
      json: { title: 'Hi', body: '<b>ok</b><iframe src="https://x"></iframe>' },
    });
    expect(await posts.json()).toEqual({ title: 'Hi', body: '<b>ok</b>' });
    const wrong = await sanitizedHtml(v.number())['~standard'].validate(1);
    expect(wrong).toEqual({
      issues: [{ message: 'sanitizedHtml() requires the inner schema to output a string' }],
    });
  });
});

describe('security: documented edge cases', () => {
  @Controller('/')
  class EdgeController {
    @Get('/open')
    open() {
      return 'ok';
    }
    @Get('/truthy')
    @UseGuards(() => 1 as unknown as boolean)
    truthy() {
      return 'never';
    }
  }

  test('allowedHosts answers other hosts with 421 before middleware', async () => {
    @Module({ imports: [SecurityHeadersModule.forRoot()], controllers: [EdgeController] })
    class App {}
    const { app } = await serve([App], { allowedHosts: ['127.0.0.1'] });
    expect((await app.request('GET', '/open')).status).toBe(200);
    const other = await app.request('GET', '/open', { headers: { host: 'evil.example' } });
    expect(other.status).toBe(421);
    expect(other.headers.get('content-security-policy')).toBeNull();
  });

  test('maxParams: too many query parameters is a 400', async () => {
    @Controller('/')
    class Search {
      @Get('/search')
      search(ctx: Ctx) {
        return ctx.query;
      }
    }
    @Module({ controllers: [Search] })
    class App {}
    const { app } = await serve([App], { maxParams: 2 });
    expect((await app.request('GET', '/search?a=1&b=2')).status).toBe(200);
    expect((await app.request('GET', '/search?a=1&b=2&c=3')).status).toBe(400);
  });

  test('a guard returning a truthy non-true value is a 403', async () => {
    @Module({ controllers: [EdgeController] })
    class App {}
    const { app } = await serve([App], { development: false });
    const res = await app.request('GET', '/truthy');
    expect(res.status).toBe(403);
  });

  test("onMissingKey 'deny' is a 403; onStoreError 'deny' is a masked 503", async () => {
    const failing: RateLimitStore = {
      consume: () => Promise.reject(new Error('redis down')),
    };
    @Module({
      imports: [
        RateLimitModule.forRoot({
          limit: 1,
          window: '1m',
          key: () => undefined,
          onMissingKey: 'deny',
        }),
      ],
      controllers: [EdgeController],
    })
    class DenyKey {}
    const a = await serve([DenyKey], { development: false });
    const denied = await a.app.request('GET', '/open');
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { detail: string }).detail).toBe(
      'Rate limiting requires a client key',
    );
    @Module({
      imports: [
        RateLimitModule.forRoot({ limit: 1, window: '1m', store: failing, onStoreError: 'deny' }),
      ],
      controllers: [EdgeController],
    })
    class DenyStore {}
    const b = await serve([DenyStore], { development: false });
    const down = await b.app.request('GET', '/open');
    expect(down.status).toBe(503);
    const body = (await down.json()) as Record<string, unknown>;
    expect(body.detail).toBeUndefined();
    expect(body.title).toBe('Service Unavailable');
    @Module({
      imports: [RateLimitModule.forRoot({ limit: 1, window: '1m', store: failing })],
      controllers: [EdgeController],
    })
    class AllowStore {}
    const c = await serve([AllowStore]);
    const through = await c.app.request('GET', '/open');
    expect(through.status).toBe(200);
    expect(through.headers.get('ratelimit-limit')).toBeNull();
    expect(
      c.mod.logs.some((e) => e.level === 'warn' && e.message.includes('Rate limit store failed')),
    ).toBe(true);
  });

  test('on a denial RateLimit-Reset equals Retry-After; a method @RateLimit replaces the class one', async () => {
    @Controller('/r')
    @RateLimit({ limit: 2 })
    class R {
      @Get('/a')
      @RateLimit({ window: '1h' })
      a() {
        return 'a';
      }
      @Get('/b')
      b() {
        return 'b';
      }
    }
    @Module({ imports: [RateLimitModule.forRoot({ limit: 3, window: '1m' })], controllers: [R] })
    class App {}
    const { app } = await serve([App]);
    // The method's limit is the module's 3, not the class's 2.
    expect((await app.request('GET', '/r/a')).headers.get('ratelimit-limit')).toBe('3');
    expect((await app.request('GET', '/r/b')).headers.get('ratelimit-limit')).toBe('2');
    await app.request('GET', '/r/b');
    const denied = await app.request('GET', '/r/b');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('ratelimit-reset')).toBe(denied.headers.get('retry-after'));
  });

  test('4xx responses keep their detail in production', async () => {
    @Module({ controllers: [EdgeController] })
    class App {}
    const { app } = await serve([App], { development: false });
    const res = await app.request('GET', '/nope');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No route for GET /nope',
      instance: '/nope',
    });
  });
});
