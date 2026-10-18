import { afterEach, describe, expect, test } from 'bun:test';
import { CorsModule } from '@knead-js/cors';
import { Controller, type Ctx, Get, HttpConfigError } from '@knead-js/http';
import { RateLimitModule } from '@knead-js/rate-limit';
import { Test, type TestingModule } from '@knead-js/testing';
import {
  SecurityHeaders,
  SecurityHeadersModule,
  type SecurityHeadersOptions,
} from '../src/index.js';

@Controller('/')
class PageController {
  @Get('/json') json() {
    return { ok: true };
  }
  @Get('/framed') framed(ctx: Ctx) {
    ctx.res.headers.set('x-frame-options', 'SAMEORIGIN');
    return 'framed';
  }
  @Get('/page') page(ctx: Ctx) {
    return new Response(`<script nonce="${ctx.state.cspNonce}"></script>`, {
      headers: { 'content-type': 'text/html' },
    });
  }
  @Get('/embed')
  @SecurityHeaders({ xFrameOptions: 'SAMEORIGIN', contentSecurityPolicy: false })
  embed() {
    return 'embed';
  }
  @Get('/state') @SecurityHeaders({ contentSecurityPolicy: false }) state(ctx: Ctx) {
    return { nonce: ctx.state.cspNonce ?? null };
  }
  @Get('/boom') boom() {
    throw new Error('x');
  }
}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function serve(options?: SecurityHeadersOptions, listen = {}) {
  mod = await Test.createModule({
    imports: [SecurityHeadersModule.forRoot(options)],
    controllers: [PageController],
  }).compile();
  return mod.createApp(listen);
}

describe('SecurityHeadersModule', () => {
  test('applies strict defaults without HSTS on plain HTTP', async () => {
    const app = await serve();
    const res = await app.request('GET', '/json');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  test('HSTS is sent when a trusted proxy reports HTTPS', async () => {
    const app = await serve(undefined, { trustProxy: ['127.0.0.1'] });
    const res = await app.request('GET', '/json', { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  test('applies to 404 and 500 responses', async () => {
    const app = await serve();
    expect((await app.request('GET', '/missing')).headers.get('x-frame-options')).toBe('DENY');
    expect((await app.request('GET', '/boom')).headers.get('x-frame-options')).toBe('DENY');
  });

  test('never overwrites headers the handler set', async () => {
    const app = await serve();
    expect((await app.request('GET', '/framed')).headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  test('per-route overrides', async () => {
    const app = await serve();
    const res = await app.request('GET', '/embed');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  test('nonces are per request and appear in the CSP and ctx.state', async () => {
    const app = await serve({ contentSecurityPolicy: { nonce: true } });
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const res = await app.request('GET', '/page');
      const nonce = /nonce="([^"]+)"/.exec(await res.text())![1]!;
      expect(res.headers.get('content-security-policy')).toContain(
        `script-src 'self' 'nonce-${nonce}'`,
      );
      nonces.push(nonce);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces[0]!.length).toBeGreaterThanOrEqual(22);
  });

  test('disabling individual headers', async () => {
    const app = await serve({
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: false,
    });
    const res = await app.request('GET', '/json');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  test('reportOnly sends only the report-only header', async () => {
    const app = await serve({ contentSecurityPolicy: { reportOnly: true } });
    const res = await app.request('GET', '/json');
    expect(res.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  test('two requests produce identical headers except the nonce', async () => {
    const app = await serve(
      { contentSecurityPolicy: { nonce: { scripts: true, styles: true } } },
      { trustProxy: ['127.0.0.1'] },
    );
    const snapshot = async (secure: boolean) => {
      const res = await app.request('GET', '/page', {
        headers: secure ? { 'x-forwarded-proto': 'https' } : {},
      });
      const nonce = /nonce="([^"]+)"/.exec(await res.text())![1]!;
      const all = [...res.headers]
        .filter(([name]) => name !== 'date' && name !== 'content-length')
        .map(([name, value]) => [name, value.replaceAll(nonce, 'NONCE')]);
      return { nonce, all };
    };
    for (const secure of [false, true]) {
      const a = await snapshot(secure);
      const b = await snapshot(secure);
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.all).toEqual(b.all);
      expect(Object.fromEntries(a.all)['strict-transport-security'] !== undefined).toBe(secure);
      expect(Object.fromEntries(a.all)['content-security-policy']).toBe(
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; script-src 'self' 'nonce-NONCE'; style-src 'self' 'nonce-NONCE'",
      );
    }
  });

  test('route with CSP disabled under a nonce module has no CSP and no nonce', async () => {
    const app = await serve({ contentSecurityPolicy: { nonce: true } });
    const res = await app.request('GET', '/state');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.json()).toEqual({ nonce: null });
  });

  test('nonce styles:true extends style-src end to end', async () => {
    const app = await serve({ contentSecurityPolicy: { nonce: { styles: true } } });
    const res = await app.request('GET', '/page');
    const nonce = /nonce="([^"]+)"/.exec(await res.text())![1]!;
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
  });
});

describe('ordering with CORS and rate limiting', () => {
  async function serveStack() {
    mod = await Test.createModule({
      imports: [
        CorsModule.forRoot({
          origin: (origin) => {
            if (origin === 'https://broken.example') throw new Error('predicate failed');
            return origin === 'https://app.example';
          },
        }),
        RateLimitModule.forRoot({ limit: 1, window: '1m' }),
        SecurityHeadersModule.forRoot(),
      ],
      controllers: [PageController],
    }).compile();
    return mod.createApp();
  }

  test('a CORS preflight 204 carries security headers', async () => {
    const app = await serveStack();
    const res = await app.request('OPTIONS', '/json', {
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('a rate-limit 429 carries security headers', async () => {
    const app = await serveStack();
    expect((await app.request('GET', '/json')).status).toBe(200);
    const limited = await app.request('GET', '/json');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-frame-options')).toBe('DENY');
    expect(limited.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('an error thrown by the CORS origin predicate carries security headers', async () => {
    const app = await serveStack();
    const res = await app.request('GET', '/json', {
      headers: { origin: 'https://broken.example' },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('short HSTS max-age', () => {
  const warnings = () =>
    mod!.logs.filter((e) => e.level === 'warn' && e.message.includes('HSTS max-age'));

  test('0 < maxAge < 15552000 logs one warning', async () => {
    mod = await Test.createModule({
      imports: [SecurityHeadersModule.forRoot({ strictTransportSecurity: { maxAge: 86_400 } })],
      controllers: [PageController],
    }).compile();
    const app = await mod.createApp();
    await app.request('GET', '/json');
    await app.request('GET', '/embed');
    expect(warnings()).toHaveLength(1);
  });

  test('the default, 15552000, 0 (clearing HSTS) and false do not warn', async () => {
    for (const strictTransportSecurity of [
      undefined,
      { maxAge: 15_552_000 },
      { maxAge: 0 },
      false as const,
    ]) {
      mod = await Test.createModule({
        imports: [SecurityHeadersModule.forRoot({ strictTransportSecurity })],
        controllers: [PageController],
      }).compile();
      const app = await mod.createApp();
      await app.request('GET', '/json');
      expect(warnings()).toHaveLength(0);
      await mod.close();
      mod = undefined;
    }
  });
});

describe('merged HSTS options are validated at startup', () => {
  async function create(options: SecurityHeadersOptions, controller: new () => object) {
    mod = await Test.createModule({
      imports: [SecurityHeadersModule.forRoot(options)],
      controllers: [controller],
    }).compile();
    return mod.createApp({ trustProxy: ['127.0.0.1'] });
  }

  test('a route preload over a module maxAge under one year is rejected', async () => {
    @Controller('/')
    class PreloadRoute {
      @Get('/') @SecurityHeaders({ strictTransportSecurity: { preload: true } }) home() {
        return 'ok';
      }
    }
    const app = create({ strictTransportSecurity: { maxAge: 86_400 } }, PreloadRoute);
    await expect(app).rejects.toThrow(HttpConfigError);
    await expect(app).rejects.toThrow('PreloadRoute.home');
    await expect(app).rejects.toThrow('HSTS preload requires maxAge >= 31536000');
  });

  test('a controller includeSubDomains: false under a module preload is rejected', async () => {
    @Controller('/')
    @SecurityHeaders({ strictTransportSecurity: { includeSubDomains: false } })
    class NoSubdomains {
      @Get('/') home() {
        return 'ok';
      }
    }
    const app = create({ strictTransportSecurity: { preload: true } }, NoSubdomains);
    await expect(app).rejects.toThrow('HSTS preload requires includeSubDomains.');
  });

  test('a route maxAge under one year over a module preload is rejected', async () => {
    @Controller('/')
    class ShortRoute {
      @Get('/') @SecurityHeaders({ strictTransportSecurity: { maxAge: 86_400 } }) home() {
        return 'ok';
      }
    }
    const app = create({ strictTransportSecurity: { preload: true } }, ShortRoute);
    await expect(app).rejects.toThrow(HttpConfigError);
  });

  test('valid merges start, and the merged header is sent', async () => {
    @Controller('/')
    class Valid {
      @Get('/') @SecurityHeaders({ strictTransportSecurity: { preload: true } }) home() {
        return 'ok';
      }
    }
    const app = await create({ strictTransportSecurity: { maxAge: 63_072_000 } }, Valid);
    const res = await app.request('GET', '/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });
});
