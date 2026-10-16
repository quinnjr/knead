import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { Module } from '@knead-js/core';
import { HttpConfigError } from '@knead-js/http';
import { Test } from '@knead-js/testing';
import { GraphQLModule, Int, Query, Resolver, Subscription } from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

@Resolver()
class R {
  @Query(() => Int) n() {
    return 1;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
});

/** GETs the playground over raw TCP with the given Host header and returns the whole response. */
function playgroundWithHost(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          'GET /graphql HTTP/1.1',
          `Host: ${host}`,
          'Accept: text/html',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

const subscriptionEndpointIn = (html: string) =>
  /subscriptionEndpoint:\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1];

describe('playground subscription endpoint', () => {
  test('derived from a plain Host header', async () => {
    s = await startGraphQL([M], { playground: true });
    const port = Number(s.app.url.port);
    const res = await playgroundWithHost(port, `localhost:${port}`);
    expect(subscriptionEndpointIn(res)).toBe(JSON.stringify(`ws://localhost:${port}/graphql`));
  });

  test('a malicious Host falls back to the relative path and is never echoed', async () => {
    s = await startGraphQL([M], { playground: true });
    const port = Number(s.app.url.port);
    const evil = 'evil.example"</script><script>alert(1)</script>';
    const res = await playgroundWithHost(port, evil);
    expect(res.startsWith('HTTP/1.1 200')).toBe(true);
    expect(res).not.toContain('evil.example');
    expect(res).not.toContain('alert(1)');
    expect(subscriptionEndpointIn(res)).toBe(JSON.stringify('/graphql'));
    for (const host of ['evil.example/path', 'user@evil.example', 'a b', 'evil.example:99999x']) {
      const other = await playgroundWithHost(port, host);
      expect(other).not.toContain(host);
    }
  });

  test('playground.subscriptionEndpoint is used as is', async () => {
    s = await startGraphQL([M], {
      playground: { subscriptionEndpoint: 'wss://api.example/graphql' },
    });
    const port = Number(s.app.url.port);
    const res = await playgroundWithHost(port, `localhost:${port}`);
    expect(subscriptionEndpointIn(res)).toBe(JSON.stringify('wss://api.example/graphql'));
  });

  test('playground.subscriptionEndpoint must be a ws(s) URL or an absolute path', () => {
    for (const subscriptionEndpoint of ['http://api.example/graphql', 'graphql', 'javascript:x']) {
      expect(() => GraphQLModule.forRoot({ playground: { subscriptionEndpoint } })).toThrow(
        HttpConfigError,
      );
    }
  });
});

describe('playground warning', () => {
  test('enabling the playground outside development logs a warning', async () => {
    s = await startGraphQL([M], { playground: true });
    expect(s.mod.logs.some((e) => e.level === 'warn' && e.message.includes('playground'))).toBe(
      true,
    );
  });

  test('no warning in development', async () => {
    const mod = await Test.createModule({
      imports: [GraphQLModule.forRoot({ playground: true, emitSchemaFile: false }), M],
    }).compile({ development: true });
    try {
      expect(mod.logs.some((e) => e.message.includes('playground'))).toBe(false);
    } finally {
      await mod.close();
    }
  });
});
