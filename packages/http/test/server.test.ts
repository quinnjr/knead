import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BeforeApplicationShutdown, inject, Module, type OnModuleInit } from '@hpmws/core';
import { HpmwsFactory, redirectToHttps } from '../src/application.js';
import { Controller, type Ctx, Get, HttpConfigError, WsRegistry } from '../src/index.js';
import { MemoryLogger } from '../src/logger.js';
import { start } from './helpers.js';

const hasOpenssl = Bun.which('openssl') !== null;
let certDir = '';

function makeCert(name: string) {
  const key = join(certDir, `${name}.key`);
  const cert = join(certDir, `${name}.crt`);
  const result = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    `/CN=${name}`,
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return { key: Bun.file(key), cert: Bun.file(cert) };
}

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'hpmws-tls-'));
});
afterAll(() => {
  Bun.spawnSync(['rm', '-rf', certDir]);
});

@Controller('/')
class InfoController {
  @Get('/secure') secure(ctx: Ctx) {
    return { secure: ctx.secure };
  }
  @Get('/slow') async slow() {
    await Bun.sleep(200);
    return 'done';
  }
  @Get('/forever') async forever() {
    await Bun.sleep(5_000);
    return 'late';
  }
}

/** Certificate subject presented on a fresh TLS handshake (async spawn: spawnSync would block the server). */
async function presentedSubject(port: number): Promise<string> {
  const proc = Bun.spawn([
    'sh',
    '-c',
    `echo | timeout 5 openssl s_client -connect 127.0.0.1:${port} 2>/dev/null | openssl x509 -noout -subject`,
  ]);
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe.skipIf(!hasOpenssl)('TLS', () => {
  test('serves HTTPS and marks ctx.secure', async () => {
    @Module({ controllers: [InfoController] })
    class M {}
    const app = await start(M, { tls: makeCert('first') });
    expect(app.url.protocol).toBe('https:');
    const res = await fetch(new URL('/secure', app.url), { tls: { rejectUnauthorized: false } });
    expect(await res.json()).toEqual({ secure: true });
    await app.close();
  });

  test.skipIf(process.platform !== 'linux')(
    'reloadTls swaps the certificate on the same port',
    async () => {
      @Module({ controllers: [InfoController] })
      class M {}
      const app = await start(M, { tls: makeCert('first') });
      const port = app.port;
      expect(await presentedSubject(port)).toBe('subject=CN=first');
      await app.reloadTls(makeCert('second'));
      expect(app.server.port).toBe(port);
      for (let i = 0; i < 4; i++) expect(await presentedSubject(port)).toBe('subject=CN=second');
      const res = await fetch(new URL('/secure', app.url), { tls: { rejectUnauthorized: false } });
      expect(res.status).toBe(200);
      await app.close();
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'reloadTls resolves while a websocket keeps the old listener open',
    async () => {
      class Gateway implements OnModuleInit {
        readonly ws = inject(WsRegistry);
        onModuleInit() {
          this.ws.register('/live', { upgrade: () => ({}) });
        }
      }
      @Module({ providers: [Gateway] })
      class M {}
      const app = await start(M, { tls: makeCert('first') });
      const socket = new WebSocket(new URL('/live', app.url).toString().replace('https', 'wss'), {
        tls: { rejectUnauthorized: false },
      } as never);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      });
      const closed = new Promise<number>((resolve) => {
        socket.onclose = (e) => resolve(e.code);
      });
      const started = Date.now();
      await app.reloadTls(makeCert('second'));
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await app.close();
      expect(await closed).toBe(1001);
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'close() drains a listener retired by reloadTls',
    async () => {
      @Module({ controllers: [InfoController] })
      class M {}
      const app = await start(M, { tls: makeCert('first') });
      const inflight = fetch(new URL('/slow', app.url), {
        tls: { rejectUnauthorized: false },
      }).then((r) => r.text());
      await Bun.sleep(30);
      const reload = app.reloadTls(makeCert('second'));
      await app.close();
      await reload;
      expect(await inflight).toBe('done');
      await expect(
        fetch(new URL('/slow', app.url), { tls: { rejectUnauthorized: false } }),
      ).rejects.toThrow();
    },
  );

  test('reloadTls during close is rejected', async () => {
    @Module({})
    class M {}
    const app = await start(M, { tls: makeCert('first') });
    const closing = app.close();
    await expect(app.reloadTls(makeCert('second'))).rejects.toThrow(
      'reloadTls() cannot be called while the application is closing.',
    );
    await closing;
  });

  test('redirectHttp bind failure rolls back the HTTPS listener', async () => {
    @Module({})
    class M {}
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const freePort = probe.port as number;
    probe.stop(true);
    const app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development: false });
    await expect(
      app.listen({
        port: freePort,
        hostname: '127.0.0.1',
        tls: makeCert('first'),
        redirectHttp: { port: blocker.port as number, hostname: '127.0.0.1' },
      }),
    ).rejects.toThrow();
    const server = await app.listen({
      port: freePort,
      hostname: '127.0.0.1',
      tls: makeCert('first'),
    });
    expect(server.port).toBe(freePort);
    await app.close();
    blocker.stop(true);
  });

  test('redirectHttp starts a 308 redirect listener', async () => {
    @Module({ controllers: [InfoController] })
    class M {}
    const app = await start(M, { tls: makeCert('redirect'), redirectHttp: { port: 0 } });
    const res = await fetch(new URL('/secure?x=1', app.redirectUrl), { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`https://127.0.0.1:${app.server.port}/secure?x=1`);
    const warnings = (app.logger as MemoryLogger).entries.filter((e) => e.level === 'warn');
    expect(warnings.some((e) => e.message.includes('redirectHttp has no host'))).toBe(true);
    await app.close();
  });
});

test('reloadTls without TLS is a configuration error', async () => {
  @Module({})
  class M {}
  const app = await start(M);
  await expect(app.reloadTls({})).rejects.toThrow(HttpConfigError);
  await app.close();
});

test('redirectHttp without tls is a configuration error', async () => {
  @Module({})
  class M {}
  const app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development: false });
  await expect(
    app.listen({ port: 0, hostname: '127.0.0.1', redirectHttp: { port: 0 } }),
  ).rejects.toThrow('redirectHttp requires tls.');
  await app.close();
});

test('port throws before listen', async () => {
  @Module({})
  class M {}
  const app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development: false });
  expect(() => app.port).toThrow(HttpConfigError);
  await app.close();
});

test('redirectToHttps omits the default port', () => {
  const res = redirectToHttps(new Request('http://example.com/a?b=1'), 443);
  expect(res.headers.get('location')).toBe('https://example.com/a?b=1');
});

describe('redirectToHttps hardening', () => {
  test('the redirect is not cacheable', () => {
    const res = redirectToHttps(new Request('http://example.com/a'), 443);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a canonical host replaces the request Host', () => {
    const req = new Request('http://evil.example/a?b=1', { headers: { host: 'evil.example' } });
    expect(redirectToHttps(req, 8443, 'example.com').headers.get('location')).toBe(
      'https://example.com:8443/a?b=1',
    );
    expect(redirectToHttps(req, 8443, 'example.com:443').headers.get('location')).toBe(
      'https://example.com/a?b=1',
    );
  });

  test.skipIf(!hasOpenssl)('redirectHttp.host is used by the redirect listener', async () => {
    @Module({ controllers: [InfoController] })
    class M {}
    const app = await start(M, {
      tls: makeCert('canonical'),
      redirectHttp: { port: 0, host: 'example.com' },
    });
    const res = await fetch(new URL('/secure', app.redirectUrl), { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`https://example.com:${app.server.port}/secure`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await app.close();
  });

  test('redirectToHttps rejects a canonical host that does not round-trip', () => {
    const req = new Request('http://evil.example/a', { headers: { host: 'evil.example' } });
    for (const host of ['1.2.3.256', '[1.2.3.4]', '[.]', '[:::]', 'xn--a', 'a:99999']) {
      expect(() => redirectToHttps(req, 443, host)).toThrow(HttpConfigError);
    }
  });

  test('good canonical hosts produce the exact Location', () => {
    const req = new Request('http://evil.example/p/q?x=1&y=%20', {
      headers: { host: 'evil.example' },
    });
    const cases: [string, number, string][] = [
      ['Example.COM', 443, 'https://example.com/p/q?x=1&y=%20'],
      ['example.com', 8443, 'https://example.com:8443/p/q?x=1&y=%20'],
      ['example.com:9443', 8443, 'https://example.com:9443/p/q?x=1&y=%20'],
      ['example.com:443', 8443, 'https://example.com/p/q?x=1&y=%20'],
      ['10.0.0.1:8443', 443, 'https://10.0.0.1:8443/p/q?x=1&y=%20'],
      ['[2001:DB8::1]', 443, 'https://[2001:db8::1]/p/q?x=1&y=%20'],
      ['[::1]:8443', 443, 'https://[::1]:8443/p/q?x=1&y=%20'],
    ];
    for (const [host, port, location] of cases) {
      expect(redirectToHttps(req, port, host).headers.get('location')).toBe(location);
    }
  });

  test.skipIf(!hasOpenssl)('an invalid redirectHttp.host is a configuration error', async () => {
    @Module({})
    class M {}
    const bad = [
      'https://example.com',
      'example.com/path',
      'a b',
      'user@example.com',
      '',
      // Values a host pattern accepts but the URL parser rejects or rewrites.
      '1.2.3.256',
      '[1.2.3.4]',
      '[.]',
      '[:::]',
      'xn--a',
      'example.com:99999',
      'example.com:0',
      'example.com:08443',
      '0x7f.1',
      '[::0001]',
    ];
    for (const host of bad) {
      const app = await HpmwsFactory.create(M, { logger: new MemoryLogger(), development: false });
      await expect(
        app.listen({
          port: 0,
          hostname: '127.0.0.1',
          tls: makeCert('bad-host'),
          redirectHttp: { port: 0, host },
        }),
      ).rejects.toThrow(HttpConfigError);
      await app.close();
    }
  });
});

describe('graceful shutdown', () => {
  test('in-flight requests finish, then shutdown hooks run; new connections are refused', async () => {
    const log: string[] = [];
    class Hooks implements BeforeApplicationShutdown {
      beforeApplicationShutdown(signal?: string) {
        log.push(`shutdown:${signal}`);
      }
    }
    @Module({ controllers: [InfoController], providers: [Hooks] })
    class M {}
    const app = await start(M);
    const base = app.url;
    const inflight = fetch(new URL('/slow', base)).then(async (r) => {
      log.push(`response:${await r.text()}`);
    });
    await Bun.sleep(30);
    await Promise.all([app.close('SIGTERM'), app.close('SIGTERM')]);
    await inflight;
    expect(log).toEqual(['response:done', 'shutdown:SIGTERM']);
    await expect(fetch(new URL('/slow', base))).rejects.toThrow();
  });

  test('shutdownTimeout bounds the drain', async () => {
    @Module({ controllers: [InfoController] })
    class M {}
    const app = await start(M, { shutdownTimeout: 50 });
    const inflight = fetch(new URL('/forever', app.url)).catch(() => 'aborted');
    await Bun.sleep(30);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await inflight).toBe('aborted');
  });

  test('open WebSockets are closed with 1001', async () => {
    class Gateway implements OnModuleInit {
      readonly ws = inject(WsRegistry);
      onModuleInit() {
        this.ws.register('/live', { upgrade: () => ({}) });
      }
    }
    @Module({ providers: [Gateway] })
    class M {}
    const app = await start(M);
    const socket = new WebSocket(new URL('/live', app.url).toString().replace('http', 'ws'));
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (e) => resolve(e.code);
    });
    await app.close();
    expect(await closed).toBe(1001);
  });

  test('enableShutdownHooks closes on signal and removes listeners', async () => {
    const log: string[] = [];
    class Hooks implements BeforeApplicationShutdown {
      beforeApplicationShutdown(signal?: string) {
        log.push(String(signal));
      }
    }
    @Module({ providers: [Hooks] })
    class M {}
    const app = await start(M);
    const before = process.listenerCount('SIGUSR2');
    app.enableShutdownHooks(['SIGUSR2'], { exit: false });
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
    process.emit('SIGUSR2', 'SIGUSR2');
    await app.close();
    expect(log).toEqual(['SIGUSR2']);
    expect(process.listenerCount('SIGUSR2')).toBe(before);
  });
  test('enableShutdownHooks after close is rejected', async () => {
    @Module({})
    class M {}
    const app = await start(M);
    await app.close();
    expect(() => app.enableShutdownHooks(['SIGUSR2'], { exit: false })).toThrow(HttpConfigError);
  });

  test('a failing close is logged, not unhandled, and still removes listeners', async () => {
    class Hooks implements BeforeApplicationShutdown {
      beforeApplicationShutdown() {
        throw new Error('hook boom');
      }
    }
    @Module({ providers: [Hooks] })
    class M {}
    const logger = new MemoryLogger();
    const app = await start(M, {}, { logger });
    const before = process.listenerCount('SIGUSR2');
    app.enableShutdownHooks(['SIGUSR2'], { exit: false });
    process.emit('SIGUSR2', 'SIGUSR2');
    await app.close().catch(() => {});
    await Bun.sleep(10);
    expect(logger.entries.some((e) => e.level === 'error' && /shutdown/i.test(e.message))).toBe(
      true,
    );
    expect(process.listenerCount('SIGUSR2')).toBe(before);
  });
  test('enableShutdownHooks exits 0 on success and 1 on failure', async () => {
    class Failing implements BeforeApplicationShutdown {
      beforeApplicationShutdown() {
        throw new Error('hook boom');
      }
    }
    @Module({})
    class Ok {}
    @Module({ providers: [Failing] })
    class Bad {}
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const ok = await start(Ok);
      ok.enableShutdownHooks(['SIGUSR2']);
      process.emit('SIGUSR2', 'SIGUSR2');
      await ok.close();
      await Bun.sleep(10);
      expect(exit).toHaveBeenLastCalledWith(0);

      const logger = new MemoryLogger();
      const bad = await start(Bad, {}, { logger });
      bad.enableShutdownHooks(['SIGUSR2']);
      process.emit('SIGUSR2', 'SIGUSR2');
      await bad.close().catch(() => {});
      await Bun.sleep(10);
      expect(exit).toHaveBeenLastCalledWith(1);
      expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
    } finally {
      exit.mockRestore();
    }
  });
});
