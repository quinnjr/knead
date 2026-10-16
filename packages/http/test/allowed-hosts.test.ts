import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { Module } from '@hpmws/core';
import { HpmwsFactory, type HttpApplication, type ListenOptions } from '../src/application.js';
import { Controller, Get } from '../src/decorators.js';
import { HttpConfigError } from '../src/exceptions.js';
import { MemoryLogger } from '../src/logger.js';
import { compileAllowedHosts } from '../src/net.js';
import { WsRegistry } from '../src/ws.js';

@Controller()
class C {
  @Get('/q')
  q() {
    return 'ok';
  }
}

@Module({ controllers: [C] })
class M {}

const UPGRADE = [
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
];

/** Sends a raw request with the given Host and returns the status line. */
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
      if (response.includes('\r\n')) socket.end();
    });
    socket.on('close', () => resolve(response.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

let app: HttpApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(development: boolean, listen: ListenOptions = {}): Promise<number> {
  app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development });
  app.get(WsRegistry).register('/live', { upgrade: () => ({}) });
  await app.listen({ port: 0, hostname: '127.0.0.1', ...listen });
  return Number(app.url.port);
}

describe('allowedHosts', () => {
  test('development: a rebinding Host gets 421 over HTTP and on WebSocket upgrades', async () => {
    const port = await serve(true);
    expect(await raw(port, 'evil.com', '/q')).toBe('HTTP/1.1 421 Misdirected Request');
    expect(await raw(port, `evil.com:${port}`, '/missing')).toBe(
      'HTTP/1.1 421 Misdirected Request',
    );
    expect(await raw(port, `evil.com:${port}`, '/live', UPGRADE)).toBe(
      'HTTP/1.1 421 Misdirected Request',
    );
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'LOCALHOST']) {
      expect(await raw(port, host, '/q')).toBe('HTTP/1.1 200 OK');
    }
    expect(await raw(port, `localhost:${port}`, '/live', UPGRADE)).toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });

  test('each rejected Host is logged once, with a hint', async () => {
    const port = await serve(true);
    for (let i = 0; i < 3; i++) await raw(port, 'evil.com', '/q');
    await raw(port, 'other.example', '/q');
    const warnings = (app!.logger as MemoryLogger).entries.filter((e) =>
      e.message.includes('allowedHosts'),
    );
    expect(warnings.map((e) => e.message.match(/Host "([^"]+)"/)?.[1])).toEqual([
      'evil.com',
      'other.example',
    ]);
    expect(warnings[0]!.message).toContain('listen({ allowedHosts })');
  });

  test('the 421 is problem+json', async () => {
    await serve(true);
    const res = await fetch(new URL('/q', app!.url), { headers: { host: 'evil.com' } });
    expect(res.status).toBe(421);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { title: string }).title).toBe('Misdirected Request');
  });

  test('production: no check by default', async () => {
    const port = await serve(false);
    expect(await raw(port, 'evil.com', '/q')).toBe('HTTP/1.1 200 OK');
  });

  test('an explicit list applies in any mode; ports and case are ignored', async () => {
    const port = await serve(false, { allowedHosts: ['App.Example', '2001:db8::1'] });
    expect(await raw(port, 'app.example:8080', '/q')).toBe('HTTP/1.1 200 OK');
    expect(await raw(port, 'app.example.', '/q')).toBe('HTTP/1.1 200 OK');
    expect(await raw(port, '[2001:DB8::1]:443', '/q')).toBe('HTTP/1.1 200 OK');
    expect(await raw(port, 'localhost', '/q')).toBe('HTTP/1.1 421 Misdirected Request');
    expect(await raw(port, 'evil.app.example', '/q')).toBe('HTTP/1.1 421 Misdirected Request');
  });

  test('false disables the development default', async () => {
    const port = await serve(true, { allowedHosts: false });
    expect(await raw(port, 'evil.com', '/q')).toBe('HTTP/1.1 200 OK');
  });

  test('invalid entries are a configuration error', () => {
    for (const entry of ['', 'a b', 'x/y', 'u@h', '[nope]']) {
      expect(() => compileAllowedHosts([entry])).toThrow(HttpConfigError);
    }
  });
});
