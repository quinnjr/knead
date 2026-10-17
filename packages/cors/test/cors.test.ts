import { afterEach, describe, expect, test } from 'bun:test';
import { inject, type OnModuleInit } from '@knead-js/core';
import { Controller, type Ctx, Get, UseGuards, WsRegistry } from '@knead-js/http';
import { Test, type TestApp } from '@knead-js/testing';
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

  test('wildcard preflights without allowedHeaders vary on Access-Control-Request-Headers', async () => {
    const a = await serve({ origin: '*' });
    const res = await a.request(
      'OPTIONS',
      '/api/data',
      preflight('https://any.example', { 'access-control-request-headers': 'x-api-key' }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('x-api-key');
    expect(res.headers.get('vary')).toBe('Access-Control-Request-Headers');
    const fixed = await serve({ origin: '*', allowedHeaders: ['content-type'] });
    const r2 = await fixed.request('OPTIONS', '/api/data', preflight('https://any.example'));
    expect(r2.headers.get('vary')).toBeNull();
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

  test.each([1, 'yes', {}])(
    'a predicate returning truthy non-true %p is not an allow (fails closed)',
    async (value) => {
      for (const origin of [
        () => value as unknown as boolean,
        async () => value as unknown as boolean,
      ]) {
        const a = await serve({ origin, credentials: true });
        const simple = await a.request('GET', '/api/data', {
          headers: { origin: 'https://f.example' },
        });
        const pre = await a.request('OPTIONS', '/api/data', preflight('https://f.example'));
        for (const r of [simple, pre]) {
          expect(r.headers.get('access-control-allow-origin')).toBeNull();
          expect(r.headers.get('access-control-allow-credentials')).toBeNull();
        }
        await a.close();
        app = undefined;
      }
    },
  );

  test('exact-string semantics for origin lists', async () => {
    const a = await serve({ origin: ['https://a.example', 'https://b.example'] });
    for (const [o, ok] of [
      ['https://a.example', true],
      ['https://A.example', false],
      ['https://a.example/', false],
      ['https://a.exampl', false],
    ] as const) {
      const res = await a.request('GET', '/api/data', { headers: { origin: o } });
      expect(res.headers.get('access-control-allow-origin') !== null).toBe(ok);
    }
  });

  test('the configured strings are reused unchanged on every request', async () => {
    const a = await serve({
      origin: 'https://app.example',
      methods: ['GET'],
      allowedHeaders: ['a', 'b'],
      exposedHeaders: ['x-total', 'x-page'],
      maxAge: 0,
    });
    for (let i = 0; i < 2; i++) {
      const pre = await a.request('OPTIONS', '/api/data', preflight('https://app.example'));
      expect(pre.headers.get('access-control-allow-methods')).toBe('GET');
      expect(pre.headers.get('access-control-allow-headers')).toBe('a, b');
      expect(pre.headers.get('access-control-max-age')).toBe('0');
      const res = await a.request('GET', '/api/data', {
        headers: { origin: 'https://app.example' },
      });
      expect(res.headers.get('access-control-expose-headers')).toBe('x-total, x-page');
    }
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

  test('an origin that is not a string, string array, RegExp or function is rejected', () => {
    for (const origin of [undefined, null, 42, true, {}, [42], ['https://a.example', null]]) {
      expect(() => CorsModule.forRoot({ origin } as unknown as CorsOptions)).toThrow(
        CorsConfigError,
      );
      expect(() => CorsModule.forRoot({ origin } as unknown as CorsOptions)).toThrow(
        'CORS origin must be',
      );
    }
    for (const origin of ['https://a.example', [], ['https://a.example'], () => true]) {
      expect(() => CorsModule.forRoot({ origin } as CorsOptions)).not.toThrow();
    }
  });
});

describe('WebSocket upgrades', () => {
  class Gateway implements OnModuleInit {
    readonly ws = inject(WsRegistry);
    onModuleInit() {
      // '*' turns off WsRegistry's own same-origin check, so these tests exercise CORS alone.
      this.ws.register('/live', { upgrade: () => ({}) }, { allowedOrigins: '*' });
    }
  }

  async function serveWs(options: CorsOptions): Promise<TestApp> {
    const mod = await Test.createModule({
      imports: [CorsModule.forRoot(options)],
      providers: [Gateway],
    }).compile();
    app = await mod.createApp();
    return app;
  }

  /** Sends a raw HTTP upgrade request and resolves with the response status line. */
  async function rawUpgrade(a: TestApp, origin?: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let buffer = '';
    const socket = await Bun.connect({
      hostname: a.url.hostname,
      port: Number(a.url.port),
      socket: {
        data(s, chunk) {
          buffer += chunk.toString();
          const end = buffer.indexOf('\r\n');
          if (end !== -1) {
            resolve(buffer.slice(0, end));
            s.end();
          }
        },
        error(_s, error) {
          reject(error);
        },
        close() {
          resolve(buffer.split('\r\n')[0] ?? '');
        },
      },
    });
    const lines = [
      'GET /live HTTP/1.1',
      `Host: ${a.url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      ...(origin ? [`Origin: ${origin}`] : []),
    ];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    return promise;
  }

  test('a disallowed Origin is rejected with 403', async () => {
    const a = await serveWs({ origin: 'https://app.example' });
    expect(await rawUpgrade(a, 'https://evil.example')).toMatch(/^HTTP\/1\.1 403/);
  });

  test('a predicate returning a truthy non-true value does not let an upgrade through', async () => {
    for (const value of [1, {}]) {
      const a = await serveWs({ origin: () => value as unknown as boolean });
      expect(await rawUpgrade(a, 'https://f.example')).toMatch(/^HTTP\/1\.1 403/);
      await a.close();
      app = undefined;
    }
  });

  test('an allowed Origin and a missing Origin are upgraded', async () => {
    const a = await serveWs({ origin: 'https://app.example' });
    expect(await rawUpgrade(a, 'https://app.example')).toMatch(/^HTTP\/1\.1 101/);
    expect(await rawUpgrade(a)).toMatch(/^HTTP\/1\.1 101/);
  });

  test('a browser-style client from an allowed origin connects; a disallowed one does not', async () => {
    const a = await serveWs({ origin: 'https://app.example' });
    const url = new URL('/live', a.url).toString().replace('http', 'ws');
    const outcome = (origin: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(url, { headers: { origin } } as unknown as string[]);
        socket.onopen = () => {
          socket.close();
          resolve('open');
        };
        socket.onerror = () => resolve('error');
      });
    expect(await outcome('https://app.example')).toBe('open');
    expect(await outcome('https://evil.example')).toBe('error');
  });
});

describe('oversized Origin headers', () => {
  const long = `https://${'a'.repeat(2048)}.example`;

  test('an Origin longer than 2048 characters is never allowed', async () => {
    let calls = 0;
    const a = await serve({
      origin: (origin) => {
        calls++;
        return origin.endsWith('.example');
      },
    });
    const res = await a.request('GET', '/api/data', { headers: { origin: long } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(calls).toBe(0);
    const ok = await a.request('GET', '/api/data', { headers: { origin: 'https://b.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://b.example');
  });

  test("even origin: '*' does not answer an oversized Origin", async () => {
    const a = await serve({ origin: '*' });
    const res = await a.request('OPTIONS', '/api/data', {
      headers: { origin: long, 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('RegExp origins must be anchored', () => {
  test('an unanchored RegExp is a configuration error naming the option', () => {
    for (const origin of [/app\.example/, /^https:\/\/app\.example/, /app\.example$/, /^a\$/]) {
      expect(() => CorsModule.forRoot({ origin })).toThrow(CorsConfigError);
      expect(() => CorsModule.forRoot({ origin })).toThrow('CORS origin RegExp');
    }
  });

  test('top-level alternation is rejected with a hint to group it', () => {
    for (const origin of [/^https:\/\/a\.com|https:\/\/b\.com$/, /^a$|^b$/]) {
      expect(() => CorsModule.forRoot({ origin })).toThrow(CorsConfigError);
      expect(() => CorsModule.forRoot({ origin })).toThrow('^(?:a|b)$');
    }
  });

  test('alternation inside groups or classes, or escaped, is fine', () => {
    for (const origin of [
      /^https:\/\/(?:a|b)\.com$/,
      /^https:\/\/[a|b]\.com$/,
      /^https:\/\/a\|b\.com$/,
      /^(https:\/\/(x|y)\.com)$/,
    ]) {
      expect(() => CorsModule.forRoot({ origin })).not.toThrow();
    }
  });

  test('anchored RegExps are accepted', () => {
    for (const origin of [/^https:\/\/app\.example$/, /^https:\/\/(?:a|b)\.example$/i, /^a\\$/]) {
      expect(() => CorsModule.forRoot({ origin })).not.toThrow();
    }
  });
});
