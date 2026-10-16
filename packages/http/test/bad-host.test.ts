import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { Module } from '@knead/core';
import { type HttpApplication, redirectToHttps } from '../src/application.js';
import { Controller, Get } from '../src/decorators.js';
import { BadRequestException } from '../src/exceptions.js';
import type { Ctx } from '../src/types.js';
import { WsRegistry } from '../src/ws.js';
import { start } from './helpers.js';

@Controller()
class C {
  @Get('/q')
  q(ctx: Ctx) {
    return { query: ctx.query };
  }
  @Get('/boom')
  boom() {
    throw new BadRequestException('nope');
  }
}

@Module({ controllers: [C] })
class M {}

/** Sends a raw request with the given Host and returns the status line ('' if none). */
function raw(port: number, host: string, path: string, extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close', ...extra, '', ''].join(
          '\r\n',
        ),
      );
    });
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response.split('\r\n')[0] ?? ''));
    socket.on('close', () => resolve(response.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const BAD_HOSTS = ['evil"</script>', 'a b', 'x/y', 'user@host'];

describe('requests whose Host does not form a valid URL', () => {
  test('routes, errors and 404s still answer', async () => {
    app = await start(M);
    const port = Number(app.url.port);
    for (const host of BAD_HOSTS) {
      expect(await raw(port, host, '/q?a=1')).toBe('HTTP/1.1 200 OK');
      expect(await raw(port, host, '/boom')).toBe('HTTP/1.1 400 Bad Request');
      expect(await raw(port, host, '/missing')).toBe('HTTP/1.1 404 Not Found');
    }
  });

  test('a WebSocket upgrade with such a Host is rejected, not dropped', async () => {
    app = await start(M);
    app.get(WsRegistry);
    const port = Number(app.url.port);
    const upgrade = [
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
    ];
    for (const host of BAD_HOSTS) {
      expect(await raw(port, host, '/q', upgrade)).toMatch(/^HTTP\/1\.1 [24]\d\d /);
    }
  });
});

describe('redirectToHttps with a Host that does not form a valid URL', () => {
  const req = { url: '/path?x=1', headers: new Headers() } as unknown as Request;

  test('is 400 without a canonical host', async () => {
    const res = redirectToHttps(req, 443);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('is 400 when the Host header is not a strict host[:port]', () => {
    for (const host of [
      'a b',
      '1.2.3.256',
      '[1.2.3.4]',
      'xn--a',
      'evil.com/x',
      'u@evil.com',
      '0x7f.1',
    ]) {
      const res = redirectToHttps(new Request('http://placeholder/p', { headers: { host } }), 443);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  test('a valid Host header is redirected with the HTTPS port', () => {
    const res = redirectToHttps(
      new Request('http://placeholder/p?q=1', { headers: { host: 'App.Example:8080' } }),
      8443,
    );
    expect(res.headers.get('location')).toBe('https://app.example:8443/p?q=1');
  });

  test('redirects to the canonical host when one is configured', () => {
    const res = redirectToHttps(req, 443, 'app.example');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://app.example/path?x=1');
  });
});
