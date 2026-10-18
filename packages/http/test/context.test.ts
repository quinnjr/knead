import { describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import { RequestContext } from '../src/context.js';
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

  test('an untrusted peer cannot spoof forwarding headers under CIDR trust', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
    });
    const ctx = makeCtx(req, { address: '8.8.8.8', net: { trust: compileTrust(['10.0.0.0/8']) } });
    expect(ctx.ip).toBe('8.8.8.8');
    expect(ctx.secure).toBe(false);
  });

  test('ip and secure share one remote address and X-Forwarded-For lookup', () => {
    for (const trust of [compileTrust(false), compileTrust(1), compileTrust(['10.0.0.0/8'])]) {
      const req = new Request('http://localhost/', {
        headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
      });
      let lookups = 0;
      const server = {
        requestIP: () => {
          lookups++;
          return { address: '10.0.0.1', family: 'IPv4', port: 50000 };
        },
      } as unknown as Server<any>;
      const get = spyOn(req.headers, 'get');
      const ctx = new RequestContext(req, server, null, { trust, tls: false });
      const first = [ctx.ip, ctx.secure];
      expect([ctx.ip, ctx.secure]).toEqual(first);
      expect(lookups).toBe(1);
      expect(get.mock.calls.filter(([name]) => name === 'x-forwarded-for').length).toBeLessThan(2);
      expect(first).toEqual(trust.kind === 'none' ? ['10.0.0.1', false] : ['203.0.113.9', true]);
    }
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
