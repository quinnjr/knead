import { afterEach, describe, expect, test } from 'bun:test';
import { Controller, type Ctx, Get } from '@hpmws/http';
import { Test, type TestingModule } from '@hpmws/testing';
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
});
