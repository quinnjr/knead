// Runs the snippets that do their work at import time (entry points, scripts, module-level stores),
// so they are executed and not only typechecked. listen() is redirected to an ephemeral port on
// 127.0.0.1, Bun.write and process.exit are stubbed, and nothing connects to Redis or a database.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { HttpApplication, HttpConfigError, type ListenOptions } from '@knead-js/http';
import { SchedulerRegistry } from '@knead-js/schedule';
import { Test } from '@knead-js/testing';

const snippets = join(import.meta.dir, '..', 'snippets');

const apps: HttpApplication[] = [];
afterEach(async () => {
  mock.restore();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Imports an entry point that calls listen(), and returns the app with its listen options. */
async function runMain(
  path: string,
): Promise<{ app: HttpApplication; options: ListenOptions; url: URL }> {
  const listen = HttpApplication.prototype.listen;
  let captured: { app: HttpApplication; options: ListenOptions } | undefined;
  spyOn(HttpApplication.prototype, 'listen').mockImplementation(function (
    this: HttpApplication,
    options: ListenOptions = {},
  ) {
    captured = { app: this, options };
    apps.push(this);
    return listen.call(this, { ...options, port: 0, hostname: '127.0.0.1' });
  });
  await import(join(snippets, path));
  if (!captured) throw new Error(`${path} did not call listen()`);
  return { ...captured, url: captured.app.url };
}

describe('entry points that listen', () => {
  test('home/hello.ts serves its route', async () => {
    const { url } = await runMain('home/hello.ts');
    const res = await fetch(new URL('/greet/ada', url));
    expect(await res.json()).toEqual({ message: 'hello ada' });
  });

  test('start/main.ts listens on loopback with shutdown hooks', async () => {
    const before = process.listenerCount('SIGTERM');
    const { options } = await runMain('start/main.ts');
    expect(options).toEqual({ port: 3000, hostname: '127.0.0.1' });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });

  test('graphql/main.ts serves the schema', async () => {
    const { url, options } = await runMain('graphql/main.ts');
    expect(options).toEqual({ port: 3000 });
    const res = await fetch(new URL('/graphql', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(await res.json()).toEqual({ data: { __typename: 'Query' } });
  });

  test('security/hardened-main.ts accepts its listen options and refuses other hosts', async () => {
    const { url, options } = await runMain('security/hardened-main.ts');
    expect(options.allowedHosts).toEqual(['api.example.com']);
    const health = (host: string) =>
      fetch(new URL('/health', url), { headers: { host } }).then((r) => r.status);
    expect(await health('api.example.com')).toBe(200);
    expect(await health('evil.example')).toBe(421);
  });
});

describe('scripts', () => {
  test('graphql/print-schema.ts writes the sorted schema and closes the app', async () => {
    const write = spyOn(Bun, 'write').mockImplementation(
      (async () => 0) as unknown as typeof Bun.write,
    );
    await import(join(snippets, 'graphql/print-schema.ts'));
    expect(write).toHaveBeenCalledTimes(1);
    const [path, schema] = write.mock.calls[0] as unknown[];
    expect(path).toBe('schema.graphql');
    expect(schema).toContain('type Query {');
  });

  test('core/standalone-main.ts closes the context and exits 0 on SIGTERM', async () => {
    const before = {
      SIGTERM: new Set(process.listeners('SIGTERM')),
      SIGINT: new Set(process.listeners('SIGINT')),
    };
    await import(join(snippets, 'core/standalone-main.ts'));
    const added = (signal: 'SIGTERM' | 'SIGINT') =>
      process.listeners(signal).filter((l) => !before[signal].has(l)) as ((s: string) => void)[];
    const [sigterm, ...more] = added('SIGTERM');
    expect(sigterm).toBeDefined();
    expect(more).toEqual([]);
    // The SIGINT handler the snippet also registered is removed, since the test never signals it.
    expect(added('SIGINT')).toHaveLength(1);
    for (const l of added('SIGINT')) process.off('SIGINT', l);
    process.off('SIGTERM', sigterm!);
    const { promise: exited, resolve } = Promise.withResolvers<unknown>();
    spyOn(process, 'exit').mockImplementation(((code?: number) => resolve(code)) as never);
    sigterm!('SIGTERM');
    expect(await exited).toBe(0);
  });
});

describe('module-level stores', () => {
  test('schedule/locks.ts registers its locked jobs without connecting to Redis', async () => {
    const { AppModule } = await import('../snippets/schedule/locks.js');
    const mod = await Test.createModule({ imports: [AppModule] }).compile();
    try {
      const names = mod
        .get(SchedulerRegistry)
        .list()
        .map((j) => j.name)
        .sort();
      expect(names).toEqual(['charge-renewals', 'retry-failed-charges']);
    } finally {
      await mod.close();
    }
  });

  test('schedule/locks.ts refuses a plaintext redis:// URL to a remote host (requireTls)', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', `await import(${JSON.stringify(join(snippets, 'schedule/locks.ts'))})`],
      {
        env: { ...process.env, REDIS_URL: 'redis://app:s3cret@cache.internal:6379' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain('RedisLockStore connects to cache.internal:6379 over plaintext');
    expect(stderr).not.toContain('s3cret');
  });

  test('graphql/redis.ts requires TLS in production only', async () => {
    const { createPubSub } = await import('../snippets/graphql/redis.js');
    const env = {
      REDIS_URL: 'redis://cache.internal:6379',
      REDIS_PUBSUB_SIGNING_KEY: 'k'.repeat(44),
      REDIS_PUBSUB_ENCRYPTION_KEY: 'e'.repeat(44),
    };
    expect(() => createPubSub({ ...env, NODE_ENV: 'production' })).toThrow(HttpConfigError);
    const pubsub = createPubSub({ ...env, REDIS_URL: 'redis://localhost:6379' });
    await pubsub.close();
  });
});
