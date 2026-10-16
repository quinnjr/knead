import { describe, expect, test } from 'bun:test';
import { MemoryLogger } from '@hpmws/http';
import { renderPlayground } from '@leaven-graphql/playground';
import { PLAYGROUND_ASSETS, playgroundPage, servePlayground } from '../src/playground.js';

describe('playground subresource integrity', () => {
  test("every external asset in Leaven's playground HTML has a pinned hash", () => {
    // Fails when Leaven changes its asset URLs: add the new URLs and their sha384 to the map.
    const html = renderPlayground({ endpoint: '/graphql' });
    const external = [...html.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(external.length).toBeGreaterThan(0);
    for (const url of external) expect(Object.keys(PLAYGROUND_ASSETS)).toContain(url!);
  });

  test('script and stylesheet tags carry integrity and crossorigin', () => {
    const { html } = playgroundPage('/graphql');
    const script = /<script src="[^"]+"[^>]*>/.exec(html)![0];
    expect(script).toContain(
      'integrity="sha384-8ZBpoKWpyI6F5F1R0ijmRe6NtB5mkl47ax+KcynJ79OAeWCPQMuQNOOBl6ArLPGn"',
    );
    expect(script).toContain('crossorigin="anonymous"');
    const sheet = /<link\s+rel="stylesheet"[^>]*>/.exec(html)![0];
    expect(sheet).toContain(
      'integrity="sha384-xb+UHILNN4fV3NgQMTjXk0x9A80U0hmkraTFvucUYTILJymGT8E1Aq2278NSi5+3"',
    );
    expect(sheet).toContain('crossorigin="anonymous"');
  });

  test('an asset without a pinned hash refuses to serve the playground and logs why', async () => {
    const logger = new MemoryLogger();
    const res = servePlayground('/graphql', undefined, logger, {});
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('<script');
    const entry = logger.entries.find((e) => e.level === 'error');
    expect(entry?.message).toContain(
      'graphql-playground-react@1.7.26/build/static/js/middleware.js',
    );
  });
});
