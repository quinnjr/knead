import { describe, expect, test } from 'bun:test';
import { toResponse, withHeaders } from '../src/response.js';

const draft = (init?: Bun.HeadersInit) => new Headers(init);

describe('toResponse', () => {
  test('every framework-built response carries nosniff; handler Responses are left alone', () => {
    const values: unknown[] = [
      undefined,
      'text',
      new Blob(['<script>'], { type: 'text/html' }),
      new Uint8Array([1]),
      new ArrayBuffer(1),
      new ReadableStream(),
      { a: 1 },
    ];
    for (const value of values) {
      const res = toResponse(value, undefined, draft());
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(
      toResponse(new Response('raw'), undefined, draft()).headers.has('x-content-type-options'),
    ).toBe(false);
  });

  test('objects become JSON with nosniff', async () => {
    const res = toResponse({ a: 1 }, undefined, draft({ 'x-draft': '1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-draft')).toBe('1');
    expect(await res.json()).toEqual({ a: 1 });
  });

  test('null is JSON, undefined is 204 unless a status is set', async () => {
    expect(await toResponse(null, undefined, draft()).text()).toBe('null');
    const empty = toResponse(undefined, undefined, draft());
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    expect(toResponse(undefined, 201, draft()).status).toBe(201);
  });

  test('strings are text/plain', async () => {
    const res = toResponse('hi', 202, draft());
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('hi');
  });

  test('binary values stream with a sensible content type', async () => {
    const typed = toResponse(new Blob(['x'], { type: 'image/png' }), undefined, draft());
    expect(typed.headers.get('content-type')).toBe('image/png');
    const untyped = toResponse(new Blob(['x']), undefined, draft());
    expect(untyped.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = toResponse(new Uint8Array([1, 2]), undefined, draft());
    expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    const stream = toResponse(
      new Blob(['abc']).stream(),
      undefined,
      draft({ 'content-type': 'text/csv' }),
    );
    expect(stream.headers.get('content-type')).toBe('text/csv');
    expect(await stream.text()).toBe('abc');
  });

  test('Response values pass through; draft headers fill only missing ones', () => {
    const own = new Response('x', { status: 418, headers: { 'x-own': 'handler' } });
    const res = toResponse(own, 200, draft({ 'x-own': 'draft', 'x-new': 'draft' }));
    expect(res.status).toBe(418);
    expect(res.headers.get('x-own')).toBe('handler');
    expect(res.headers.get('x-new')).toBe('draft');
  });
});

describe('toResponse with a null-body status', () => {
  test('204, 205 and 304 drop the returned value', async () => {
    for (const status of [204, 205, 304]) {
      for (const value of ['text', { a: 1 }, new Uint8Array([1])]) {
        const res = toResponse(value, status, draft());
        expect(res.status).toBe(status);
        expect(res.body).toBeNull();
        expect(res.headers.has('content-type')).toBe(false);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    }
  });
});

describe('toResponse extras', () => {
  test('unserializable values throw TypeError', () => {
    expect(() => toResponse(() => 1, undefined, draft())).toThrow(
      new TypeError('Handler returned a value that cannot be serialized as JSON'),
    );
    expect(() => toResponse(Symbol('x'), undefined, draft())).toThrow(TypeError);
  });

  test('explicit draft content-type is kept for JSON, nosniff always set', async () => {
    const res = toResponse(
      { a: 1 },
      undefined,
      draft({ 'content-type': 'application/vnd.api+json' }),
    );
    expect(res.headers.get('content-type')).toBe('application/vnd.api+json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.json()).toEqual({ a: 1 });
  });

  test('immutable-header Response gets draft headers, keeps status and location', () => {
    const res = toResponse(
      Response.redirect('http://localhost/next', 302),
      200,
      draft({ 'x-draft': '1' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/next');
    expect(res.headers.get('x-draft')).toBe('1');
  });

  test('ArrayBuffer is octet-stream with the same bytes', async () => {
    const res = toResponse(new Uint8Array([3, 4]).buffer, undefined, draft());
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3, 4]));
  });
});

describe('withHeaders', () => {
  test('works on responses with immutable headers', () => {
    const res = withHeaders(Response.redirect('http://localhost/next', 302), { 'x-a': '1' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/next');
    expect(res.headers.get('x-a')).toBe('1');
  });

  test('re-wraps into a new Response when headers reject mutation', async () => {
    const real = new Headers({ 'x-keep': 'k' });
    const frozen = {
      get: (k: string) => real.get(k),
      has: (k: string) => real.has(k),
      getSetCookie: () => real.getSetCookie(),
      set(): never {
        throw new TypeError('immutable');
      },
      append(): never {
        throw new TypeError('immutable');
      },
      [Symbol.iterator]: () => real[Symbol.iterator](),
      entries: () => real.entries(),
      keys: () => real.keys(),
      values: () => real.values(),
      forEach: (cb: Parameters<Headers['forEach']>[0]) => real.forEach(cb),
    };
    const base = new Response('payload', { status: 201, headers: real });
    Object.defineProperty(base, 'headers', { value: frozen });
    const res = withHeaders(base, { 'x-a': '1' });
    expect(res).not.toBe(base);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('payload');
    expect(res.headers.get('x-keep')).toBe('k');
    expect(res.headers.get('x-a')).toBe('1');
  });

  test('appends set-cookie instead of replacing it', () => {
    const base = new Response(null, { headers: [['set-cookie', 'a=1']] });
    const res = withHeaders(base, [['set-cookie', 'b=2']]);
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  test('overwrite=false keeps existing values', () => {
    const res = withHeaders(
      new Response(null, { headers: { 'x-a': 'old' } }),
      { 'x-a': 'new' },
      false,
    );
    expect(res.headers.get('x-a')).toBe('old');
  });
});
