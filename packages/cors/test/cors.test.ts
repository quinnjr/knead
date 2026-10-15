import { afterEach, describe, expect, test } from 'bun:test';
import { Controller, type Ctx, Get, UseGuards } from '@hpmws/http';
import { Test, type TestApp } from '@hpmws/testing';
import { CorsConfigError, CorsModule, type CorsOptions } from '../src/index.js';

@Controller('/api')
class ApiController {
  @Get('/data') data() {
    return { ok: true };
  }
  @Get('/vary') vary(ctx: Ctx) {
    ctx.res.headers.set('vary', 'Accept-Encoding');
    return 'v';
  }
  @Get('/guarded') @UseGuards(() => false) guarded() {
    return 'g';
  }
  @Get('/boom') boom() {
    throw new Error('boom');
  }
}

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(options: CorsOptions): Promise<TestApp> {
  const mod = await Test.createModule({
    imports: [CorsModule.forRoot(options)],
    controllers: [ApiController],
  }).compile();
  app = await mod.createApp();
  return app;
}

const preflight = (origin: string, extra: Record<string, string> = {}) => ({
  headers: { origin, 'access-control-request-method': 'POST', ...extra },
});

describe('simple requests', () => {
  test('allowed origin gets exact ACAO, credentials, exposed headers and Vary', async () => {
    const a = await serve({
      origin: 'https://app.example',
      credentials: true,
      exposedHeaders: ['x-total'],
    });
    const res = await a.request('GET', '/api/data', { headers: { origin: 'https://app.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-expose-headers')).toBe('x-total');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('disallowed origins get no CORS headers but the request still runs', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const res = await a.request('GET', '/api/data', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('requests without Origin get no ACAO', async () => {
    const a = await serve({ origin: 'https://app.example' });
    expect(
      (await a.request('GET', '/api/data')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  test('wildcard origin sends * and no Vary', async () => {
    const a = await serve({ origin: '*' });
    const res = await a.request('GET', '/api/data', { headers: { origin: 'https://any.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toBeNull();
  });

  test('existing Vary values are merged', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const res = await a.request('GET', '/api/vary', { headers: { origin: 'https://app.example' } });
    expect(res.headers.get('vary')).toBe('Accept-Encoding, Origin');
  });

  test('error responses carry CORS headers too', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const boom = await a.request('GET', '/api/boom', {
      headers: { origin: 'https://app.example' },
    });
    expect(boom.status).toBe(500);
    expect(boom.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const missing = await a.request('GET', '/nope', { headers: { origin: 'https://app.example' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });
});

describe('preflight', () => {
  test('allowed preflight is a 204 with methods, reflected headers and max-age', async () => {
    const a = await serve({ origin: 'https://app.example', maxAge: 600 });
    const res = await a.request(
      'OPTIONS',
      '/api/data',
      preflight('https://app.example', {
        'access-control-request-headers': 'content-type, x-api-key',
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, PUT, PATCH, POST, DELETE',
    );
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-api-key');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('vary')).toBe('Origin, Access-Control-Request-Headers');
  });

  test('configured allowedHeaders and methods are used verbatim', async () => {
    const a = await serve({
      origin: 'https://app.example',
      allowedHeaders: ['content-type'],
      methods: ['GET', 'POST'],
    });
    const res = await a.request(
      'OPTIONS',
      '/api/data',
      preflight('https://app.example', {
        'access-control-request-headers': 'x-other',
      }),
    );
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  test('disallowed preflight is a bare 204', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const res = await a.request('OPTIONS', '/api/data', preflight('https://evil.example'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('preflight works on paths without routes', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const res = await a.request('OPTIONS', '/not/a/route', preflight('https://app.example'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });
});

describe('guards and credentials', () => {
  test('CORS runs before guards: preflight and rejected requests carry CORS headers', async () => {
    const a = await serve({ origin: 'https://app.example' });
    const pre = await a.request('OPTIONS', '/api/guarded', preflight('https://app.example'));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const res = await a.request('GET', '/api/guarded', {
      headers: { origin: 'https://app.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  test('credentials preflight for allowed origins; none for disallowed', async () => {
    const a = await serve({ origin: 'https://app.example', credentials: true });
    const ok = await a.request('OPTIONS', '/api/data', preflight('https://app.example'));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await a.request('OPTIONS', '/api/data', preflight('https://evil.example'));
    const simple = await a.request('GET', '/api/data', {
      headers: { origin: 'https://evil.example' },
    });
    for (const r of [bad, simple]) {
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

describe('origin matchers', () => {
  test.each([
    [['https://a.example', 'https://b.example'], 'https://b.example', true],
    [/^https:\/\/[a-z]+\.example$/, 'https://c.example', true],
    [/^https:\/\/[a-z]+\.example$/g, 'https://c.example', true],
    [/^https:\/\/[a-z]+\.example$/, 'https://c.example.evil', false],
  ] as const)('%p matches %p → %p', async (origin, requestOrigin, allowed) => {
    const a = await serve({ origin: origin as CorsOptions['origin'] });
    for (let i = 0; i < 2; i++) {
      const res = await a.request('GET', '/api/data', { headers: { origin: requestOrigin } });
      expect(res.headers.get('access-control-allow-origin') !== null).toBe(allowed);
    }
  });

  test('function origins receive the context', async () => {
    const a = await serve({
      origin: async (origin, ctx) => origin.endsWith('.example') && ctx.req.method === 'GET',
    });
    const res = await a.request('GET', '/api/data', { headers: { origin: 'https://f.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://f.example');
  });
});

describe('configuration validation', () => {
  test('wildcard with credentials is rejected at forRoot', () => {
    expect(() => CorsModule.forRoot({ origin: '*', credentials: true })).toThrow(CorsConfigError);
    expect(() => CorsModule.forRoot({ origin: ['*'], credentials: true })).toThrow(
      "Use origin: '*' instead of listing '*' among origins.",
    );
    expect(() => CorsModule.forRoot({ origin: ['*', 'https://a.example'] })).toThrow(
      "Use origin: '*' instead of listing '*' among origins.",
    );
    expect(() => CorsModule.forRoot({ origin: 'https://a.example', maxAge: -1 })).toThrow(
      CorsConfigError,
    );
  });
});
