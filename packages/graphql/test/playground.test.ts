import { describe, expect, test } from 'bun:test';
import { MemoryLogger } from '@knead-js/http';
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

const connectSrc = (csp: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith('connect-src '))
    ?.split(' ')
    .slice(1);

describe('playground CSP connect-src', () => {
  test('an absolute ws(s) subscription endpoint adds exactly its origin to connect-src', () => {
    expect(connectSrc(playgroundPage('/graphql', 'wss://api.example/graphql').csp)).toEqual([
      "'self'",
      'wss://api.example',
    ]);
    expect(
      connectSrc(playgroundPage('/graphql', 'ws://API.Example:8080/graphql?x=1#y').csp),
    ).toEqual(["'self'", 'ws://api.example:8080']);
    // Userinfo and the default port are not part of the origin.
    expect(connectSrc(playgroundPage('/graphql', 'wss://u:p@api.example:443/g').csp)).toEqual([
      "'self'",
      'wss://api.example',
    ]);
    expect(connectSrc(playgroundPage('/graphql', 'ws://[::1]:4000/g').csp)).toEqual([
      "'self'",
      'ws://[::1]:4000',
    ]);
  });

  test('a relative endpoint, or none, leaves connect-src at self', () => {
    expect(connectSrc(playgroundPage('/graphql').csp)).toEqual(["'self'"]);
    expect(connectSrc(playgroundPage('/graphql', '/graphql').csp)).toEqual(["'self'"]);
  });

  test('the served page carries the endpoint origin in its CSP header', () => {
    const gate = new PlaygroundGate(new MemoryLogger());
    const res = gate.serve('/graphql', 'wss://api.example/graphql');
    expect(connectSrc(res.headers.get('content-security-policy')!)).toEqual([
      "'self'",
      'wss://api.example',
    ]);
  });

  test('nothing that could break out of the directive reaches the CSP', () => {
    for (const endpoint of ['wss://a.example;script-src *', "wss://a.example'/g", 'wss://a b/g']) {
      const csp = playgroundPage('/graphql', endpoint).csp;
      expect(csp).not.toContain('script-src *');
      for (const source of connectSrc(csp)!) {
        expect(source === "'self'" || /^wss?:\/\/[a-z0-9.:[\]-]+$/.test(source)).toBe(true);
      }
    }
  });
});

describe('PlaygroundGate page cache', () => {
  test('pages are rendered once per subscription endpoint, at most 16 kept', () => {
    const gate = new PlaygroundGate(new MemoryLogger());
    const first = gate.serve('/graphql', 'ws://a.example/graphql');
    const again = gate.serve('/graphql', 'ws://a.example/graphql');
    expect(again.headers.get('content-security-policy')).toBe(
      first.headers.get('content-security-policy'),
    );
    expect(gate.cachedPages).toBe(1);
    for (let i = 0; i < 40; i++) gate.serve('/graphql', `ws://h${i}.example/graphql`);
    expect(gate.cachedPages).toBe(16);
  });

  test('every response has its own readable body', async () => {
    const gate = new PlaygroundGate(new MemoryLogger());
    const a = await gate.serve('/graphql').text();
    const b = await gate.serve('/graphql').text();
    expect(a).toBe(b);
    expect(a).toContain('<script');
  });
});
