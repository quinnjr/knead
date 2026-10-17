// Cross-package integration: every @knead-js/* package working together in one application.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inject, Module, type OnModuleDestroy, type OnModuleInit } from '@knead-js/core';
import { CorsModule } from '@knead-js/cors';
import {
  Controller,
  type Ctx,
  Get,
  type Middleware,
  type Next,
  UseMiddleware,
  WsRegistry,
} from '@knead-js/http';
import { RateLimit, RateLimitModule, SkipRateLimit } from '@knead-js/rate-limit';
import { sanitize } from '@knead-js/sanitize';
import { Interval, ScheduleModule, SchedulerRegistry } from '@knead-js/schedule';
import { SecurityHeadersModule } from '@knead-js/security-headers';
import { Test, type TestApp, type TestingModule } from '@knead-js/testing';

const ALLOWED = 'https://app.example';
const lifecycle: string[] = [];

class TrackedMiddleware implements Middleware, OnModuleInit, OnModuleDestroy {
  onModuleInit() {
    lifecycle.push('init');
  }
  onModuleDestroy() {
    lifecycle.push('destroy');
  }
  async use(ctx: Ctx, next: Next) {
    ctx.res.headers.set('x-tracked', 'yes');
    return next();
  }
}

@Controller('/it')
@UseMiddleware(TrackedMiddleware)
class ItController {
  @Get('/limited') @RateLimit({ limit: 2, window: '1m' }) limited() {
    return { ok: true };
  }
  @Get('/html') @SkipRateLimit() html() {
    return { html: sanitize('<b>ok</b><img src=x onerror=alert(1)>', 'basic') };
  }
}

class Gateway implements OnModuleInit {
  readonly ws = inject(WsRegistry);
  onModuleInit() {
    // Cross-origin browsers need both CORS and the endpoint's own Origin allowlist.
    this.ws.register('/live', { upgrade: () => ({}) }, { allowedOrigins: [ALLOWED] });
  }
}

class Heartbeat {
  beats = 0;
  @Interval(5) beat() {
    this.beats++;
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    CorsModule.forRoot({
      origin: ALLOWED,
      exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
    RateLimitModule.forRoot({ limit: 100, window: '1m' }),
    SecurityHeadersModule.forRoot(),
  ],
  controllers: [ItController],
  providers: [Gateway, Heartbeat],
})
class IntegrationModule {}

let mod: TestingModule;
let app: TestApp;
let closed = false;
const origin = { origin: ALLOWED };
const wsUrl = () => new URL('/live', app.url).toString().replace('http', 'ws');

beforeAll(async () => {
  mod = await Test.createModule({ imports: [IntegrationModule] }).compile({ development: false });
  app = await mod.createApp();
});
afterAll(async () => {
  if (!closed) await mod.close();
});

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
}

function connect(originHeader: string): Promise<{ result: 'open' | 'error'; socket: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl(), {
      headers: { origin: originHeader },
    } as unknown as string[]);
    socket.onopen = () => resolve({ result: 'open', socket });
    socket.onerror = () => resolve({ result: 'error', socket });
  });
}

describe('integration: core + http + cors + rate-limit + schedule + security-headers + sanitize + testing', () => {
  test('lazily constructed middleware was initialized at listen', () => {
    expect(lifecycle).toEqual(['init']);
  });

  test('200 carries CORS, rate-limit, security and middleware headers', async () => {
    const res = await app.request('GET', '/it/html', { headers: origin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ html: '<b>ok</b>' });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('x-tracked')).toBe('yes');
    expectSecurityHeaders(res);
  });

  test('404 carries CORS and security headers', async () => {
    const res = await app.request('GET', '/nope', { headers: origin });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expectSecurityHeaders(res);
  });

  test('429 carries Retry-After, exposed RateLimit headers, CORS and security headers', async () => {
    let res: Response | undefined;
    for (let i = 0; i < 3; i++) res = await app.request('GET', '/it/limited', { headers: origin });
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res?.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res?.headers.get('access-control-expose-headers')).toContain('Retry-After');
    expectSecurityHeaders(res as Response);
  });

  test('preflight 204 carries security headers', async () => {
    const res = await app.request('OPTIONS', '/it/limited', {
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('WebSocket upgrade: disallowed origin rejected, allowed origin accepted', async () => {
    const evil = await connect('https://evil.example');
    expect(evil.result).toBe('error');
    const good = await connect(ALLOWED);
    expect(good.result).toBe('open');
    good.socket.close();
  });

  test('scheduled jobs run alongside the HTTP app', async () => {
    const heartbeat = mod.get(Heartbeat);
    const start = heartbeat.beats;
    await Bun.sleep(30);
    expect(heartbeat.beats).toBeGreaterThan(start);
    expect(mod.get(SchedulerRegistry).get('Heartbeat.beat')?.state).toBe('scheduled');
  });

  test('graceful close() closes open sockets with 1001 and destroys the middleware', async () => {
    const { result, socket } = await connect(ALLOWED);
    expect(result).toBe('open');
    const code = new Promise<number>((resolve) => {
      socket.onclose = (e) => resolve(e.code);
    });
    await mod.close();
    closed = true;
    expect(await code).toBe(1001);
    expect(lifecycle).toEqual(['init', 'destroy']);
    const beats = mod.get(Heartbeat).beats;
    await Bun.sleep(30);
    expect(mod.get(Heartbeat).beats).toBe(beats);
  });
});
