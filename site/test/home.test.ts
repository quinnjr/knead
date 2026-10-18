// The home page states the default limits as plain text (site/src/routes/+page.svelte). Pin each
// one to the exported default it describes, or to the behaviour when no constant is exported.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@knead-js/core';
import { GRAPHQL_LIMITS } from '@knead-js/graphql';
import { Controller, type Ctx, DEFAULT_MAX_PARAMS, Get, Post, WS_DEFAULTS } from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';

const page = readFileSync(join(import.meta.dir, '../src/routes/+page.svelte'), 'utf8');
const limitsSource = /const limits = \[([\s\S]*?)\n\];/.exec(page)?.[1] ?? '';
const limits = new Map(
  [...limitsSource.matchAll(/\{ what: '([^']+)', value: '([^']+)', outcome: '([^']+)' \}/g)].map(
    ([, what, value, outcome]) => [what!, { value: value!, outcome: outcome! }],
  ),
);

const KiB = 1024;
const MiB = 1024 * KiB;
/** `1 MiB` / `256 KiB` / `1000` as a number. */
function size(value: string): number {
  const m = /^(\d+)(?: (KiB|MiB))?$/.exec(value);
  if (!m) throw new Error(`not a size: ${value}`);
  return Number(m[1]) * (m[2] === 'MiB' ? MiB : m[2] === 'KiB' ? KiB : 1);
}

const open: TestingModule[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
});

@Controller('/')
class Echo {
  @Post('/echo')
  async echo(ctx: Ctx) {
    return { length: (await ctx.req.text()).length };
  }

  @Get('/q')
  q(ctx: Ctx) {
    return { n: Object.keys(ctx.query).length };
  }
}
@Module({ controllers: [Echo] })
class EchoModule {}

async function app() {
  const mod = await Test.createModule({ imports: [EchoModule] }).compile();
  open.push(mod);
  return mod.createApp();
}

describe('home page limits', () => {
  test('lists exactly the limits pinned here', () => {
    expect([...limits.keys()]).toEqual([
      'Request body',
      'Query parameters',
      'WebSocket message',
      'Sockets per IP',
      'GraphQL depth / complexity',
      'Errors outside development',
    ]);
  });

  test('request body: 1 MiB, then 413 (no exported constant, so checked on a real server)', async () => {
    const { value, outcome } = limits.get('Request body')!;
    const max = size(value);
    expect(max).toBe(MiB);
    const a = await app();
    expect((await a.request('POST', '/echo', { body: 'x'.repeat(max) })).status).toBe(200);
    expect((await a.request('POST', '/echo', { body: 'x'.repeat(max + 1) })).status).toBe(
      Number(outcome),
    );
  });

  test('query parameters: DEFAULT_MAX_PARAMS, then 400', async () => {
    const { value, outcome } = limits.get('Query parameters')!;
    expect(size(value)).toBe(DEFAULT_MAX_PARAMS);
    const a = await app();
    const query = (n: number) => Array.from({ length: n }, (_, i) => `p${i}=1`).join('&');
    expect((await a.request('GET', `/q?${query(DEFAULT_MAX_PARAMS)}`)).status).toBe(200);
    expect((await a.request('GET', `/q?${query(DEFAULT_MAX_PARAMS + 1)}`)).status).toBe(
      Number(outcome),
    );
  });

  test('WebSocket message and sockets per IP: WS_DEFAULTS', () => {
    expect(size(limits.get('WebSocket message')!.value)).toBe(WS_DEFAULTS.maxPayloadLength);
    const sockets = limits.get('Sockets per IP')!;
    expect(size(sockets.value)).toBe(WS_DEFAULTS.maxConnectionsPerIp);
    // ws.ts: an upgrade over maxConnectionsPerIp is refused with 429 (pinned by the http tests).
    expect(sockets.outcome).toBe('429');
  });

  test('GraphQL depth / complexity: GRAPHQL_LIMITS', () => {
    expect(limits.get('GraphQL depth / complexity')!.value).toBe(
      `${GRAPHQL_LIMITS.maxDepth} / ${GRAPHQL_LIMITS.maxComplexity}`,
    );
  });
});
