import { describe, expect, test } from 'bun:test';
import { compileTrust } from '../src/net.js';
import { makeCtx } from './helpers.js';

describe('RequestContext', () => {
  test('lazily parses query and headers, and both are settable', () => {
    const ctx = makeCtx(
      new Request('http://localhost/x?page=2&tag=a&tag=b', { headers: { 'X-Id': '7' } }),
    );
    expect({ ...ctx.query }).toEqual({ page: '2', tag: ['a', 'b'] });
    expect(ctx.headers['x-id']).toBe('7');
    ctx.query = { page: 2 } as never;
    expect(ctx.query).toEqual({ page: 2 });
  });

  test('params default to an empty object outside Bun routes', () => {
    expect(makeCtx('/x').params).toEqual({});
  });

  test('ip and secure honour the net config', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
    });
    const direct = makeCtx(new Request(req), { address: '::ffff:10.0.0.1' });
    expect(direct.ip).toBe('10.0.0.1');
    expect(direct.secure).toBe(false);
    const proxied = makeCtx(new Request(req), {
      address: '10.0.0.1',
      net: { trust: compileTrust(1) },
    });
    expect(proxied.ip).toBe('203.0.113.9');
    expect(proxied.secure).toBe(true);
    expect(makeCtx('/', { net: { tls: true } }).secure).toBe(true);
  });

  test('json() parses once and is memoized', async () => {
    const ctx = makeCtx(
      new Request('http://localhost/', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    const first = await ctx.json();
    expect(first).toEqual({ a: 1 });
    expect(await ctx.json()).toBe(first);
  });

  test('state and response draft start empty', () => {
    const ctx = makeCtx('/');
    expect(ctx.state).toEqual({});
    expect(ctx.res.status).toBeUndefined();
    expect([...ctx.res.headers]).toEqual([]);
    expect(ctx.route).toBeNull();
  });
});
