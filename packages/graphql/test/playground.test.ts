import { describe, expect, test } from 'bun:test';
import { MemoryLogger } from '@hpmws/http';
import { renderPlayground } from '@leaven-graphql/playground';
import {
  PLAYGROUND_ASSETS,
  PLAYGROUND_SCRIPT_HASHES,
  PlaygroundGate,
  playgroundPage,
  playgroundScriptHashes,
} from '../src/playground.js';

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
      'integrity="sha384-ardaO17esJ2ZxvY24V1OE6X4j+Z3WKgGMptrlDLmD+2w/JC3nbQ5ZfKGY2zfOPEE"',
    );
    expect(script).toContain('crossorigin="anonymous"');
    const sheet = /<link\s+rel="stylesheet"[^>]*>/.exec(html)![0];
    expect(sheet).toContain(
      'integrity="sha384-xb+UHILNN4fV3NgQMTjXk0x9A80U0hmkraTFvucUYTILJymGT8E1Aq2278NSi5+3"',
    );
    expect(sheet).toContain('crossorigin="anonymous"');
  });

  test('an asset without a pinned hash is reported once; every request gets 503', async () => {
    const logger = new MemoryLogger();
    const gate = new PlaygroundGate(logger, {});
    const errors = () => logger.entries.filter((e) => e.level === 'error');
    expect(errors().length).toBe(1);
    expect(errors()[0]?.message).toContain(
      'graphql-playground-react@1.7.28/build/static/js/middleware.js',
    );
    for (let i = 0; i < 3; i++) {
      const res = gate.serve('/graphql');
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('<script');
    }
    expect(errors().length).toBe(1);
  });

  test("Leaven's inline script matches the pinned sha256", () => {
    // Fails when Leaven changes its inline script: review it, then update the pinned hash.
    expect(playgroundScriptHashes()).toEqual([...PLAYGROUND_SCRIPT_HASHES]);
  });

  test('an inline script that does not match the pinned hash is reported once; 503', async () => {
    const logger = new MemoryLogger();
    const gate = new PlaygroundGate(logger, PLAYGROUND_ASSETS, ['AAAA']);
    const errors = () => logger.entries.filter((e) => e.level === 'error');
    expect(errors().length).toBe(1);
    expect(errors()[0]?.message).toContain('inline scripts do not match the pinned hashes');
    for (let i = 0; i < 3; i++) {
      const res = gate.serve('/graphql');
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('<script');
    }
    expect(errors().length).toBe(1);
    expect(gate.available).toBe(false);
  });

  test('with every hash pinned the gate serves the page and logs nothing', () => {
    const logger = new MemoryLogger();
    const gate = new PlaygroundGate(logger);
    expect(gate.serve('/graphql', 'ws://localhost/graphql').status).toBe(200);
    expect(logger.entries).toEqual([]);
  });
});
