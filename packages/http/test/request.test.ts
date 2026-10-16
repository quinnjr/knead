import { describe, expect, test } from 'bun:test';
import {
  BadRequestException,
  type HttpException,
  UnsupportedMediaTypeException,
} from '../src/exceptions.js';
import { headersToObject, parseBody, parseQuery } from '../src/request.js';

const post = (body: Bun.BodyInit | null, contentType?: string) =>
  new Request('http://localhost/', {
    method: 'POST',
    body,
    headers: contentType ? { 'content-type': contentType } : {},
  });

describe('parseQuery', () => {
  test('repeated keys become arrays', () => {
    expect({ ...parseQuery(new URLSearchParams('a=1&b=2&a=3&a=4')) }).toEqual({
      a: ['1', '3', '4'],
      b: '2',
    });
  });

  test('prototype-polluting keys are dropped (Review Focus 5)', () => {
    const q = parseQuery(
      new URLSearchParams('__proto__=x&constructor=y&prototype=z&__proto__[polluted]=1&a=1'),
    );
    expect(Object.getPrototypeOf(q)).toBeNull();
    expect(Object.keys(q)).toEqual(['__proto__[polluted]', 'a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('more than maxParams parameters is a 400', () => {
    expect(() => parseQuery(new URLSearchParams('a=1&b=2&c=3'), 2)).toThrow(BadRequestException);
    expect(Object.keys(parseQuery(new URLSearchParams('a=1&b=2'), 2))).toEqual(['a', 'b']);
  });

  test('100k repeated keys are rejected in linear time', () => {
    const query = new URLSearchParams('a=1&'.repeat(100_000));
    const t0 = performance.now();
    expect(() => parseQuery(query)).toThrow(BadRequestException);
    expect(performance.now() - t0).toBeLessThan(50);
    // Repeats under the cap are collected in place, not copied on every repeat.
    const t1 = performance.now();
    expect((parseQuery(query, 200_000).a as string[]).length).toBe(100_000);
    expect(performance.now() - t1).toBeLessThan(50);
  });
});

test('headersToObject lower-cases names', () => {
  expect({ ...headersToObject(new Headers({ 'X-Api-Key': 'k', Accept: 'a' })) }).toEqual({
    'x-api-key': 'k',
    accept: 'a',
  });
});

describe('parseBody (Review Focus 1)', () => {
  test('JSON, +json and empty JSON bodies', async () => {
    expect(await parseBody(post('{"a":1}', 'application/json; charset=utf-8'))).toEqual({ a: 1 });
    expect(await parseBody(post('{"b":2}', 'application/merge-patch+json'))).toEqual({ b: 2 });
    expect(await parseBody(post('', 'application/json'))).toBeUndefined();
  });

  test('malformed JSON is a 400', async () => {
    const error = (await parseBody(post('{not json', 'application/json')).catch(
      (e) => e,
    )) as BadRequestException;
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.status).toBe(400);
    expect(error.detail).toBe('Malformed JSON body');
  });

  test('urlencoded forms are parsed safely', async () => {
    const body = (await parseBody(
      post('a=1&a=2&__proto__=x&constructor=y', 'application/x-www-form-urlencoded'),
    )) as object;
    expect(Object.getPrototypeOf(body)).toBeNull();
    expect(Object.entries(body)).toEqual([['a', ['1', '2']]]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('JSON bodies drop __proto__ at every depth, and constructor/prototype objects', async () => {
    const body = (await parseBody(
      post(
        '{"a":{"__proto__":{"admin":true},"b":{"constructor":{"prototype":{"x":1}},"prototype":{}}},"constructor":"ok","__proto__":{"admin":true}}',
        'application/json',
      ),
    )) as Record<string, any>;
    expect(Object.hasOwn(body, '__proto__')).toBe(false);
    expect(Object.hasOwn(body.a, '__proto__')).toBe(false);
    expect(Object.keys(body.a.b)).toEqual([]);
    expect(Reflect.get(body, 'constructor')).toBe('ok');
    class Entity {
      admin = false;
      nested: Record<string, unknown> = {};
    }
    const entity = Object.assign(new Entity(), body);
    expect(entity).toBeInstanceOf(Entity);
    expect(Object.getPrototypeOf(entity)).toBe(Entity.prototype);
    expect((entity as unknown as { admin: boolean }).admin).toBe(false);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  test('forms with more than maxParams fields are a 413', async () => {
    const error = (await parseBody(
      post('a=1&b=2&c=3', 'application/x-www-form-urlencoded'),
      2,
    ).catch((e) => e)) as HttpException;
    expect(error.status).toBe(413);
    const form = new FormData();
    for (let i = 0; i < 3; i++) form.append('f', String(i));
    const multipart = (await parseBody(
      new Request('http://localhost/', { method: 'POST', body: form }),
      2,
    ).catch((e) => e)) as HttpException;
    expect(multipart.status).toBe(413);
  });

  test('100k repeated keys in a 1 MiB body are rejected quickly', async () => {
    const text = 'a=1&'.repeat(100_000);
    expect(text.length).toBeLessThanOrEqual(1024 * 1024);
    const t0 = performance.now();
    const error = (await parseBody(post(text, 'application/x-www-form-urlencoded')).catch(
      (e) => e,
    )) as HttpException;
    expect(error.status).toBe(413);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test('multipart forms keep files and repeated fields', async () => {
    const form = new FormData();
    form.append('tag', 'a');
    form.append('tag', 'b');
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    const body = (await parseBody(
      new Request('http://localhost/', { method: 'POST', body: form }),
    )) as Record<string, unknown>;
    expect(body.tag).toEqual(['a', 'b']);
    expect(body.file).toBeInstanceOf(File);
    expect(await (body.file as File).text()).toBe('hello');
  });

  test('text bodies are strings', async () => {
    expect(await parseBody(post('hi', 'text/plain'))).toBe('hi');
  });

  test('no body is undefined', async () => {
    expect(await parseBody(new Request('http://localhost/'))).toBeUndefined();
    expect(await parseBody(post(null))).toBeUndefined();
  });

  test('unsupported or missing content types with a body are a 415', async () => {
    const xml = (await parseBody(post('<a/>', 'application/xml')).catch(
      (e) => e,
    )) as UnsupportedMediaTypeException;
    expect(xml).toBeInstanceOf(UnsupportedMediaTypeException);
    expect(xml.detail).toBe('Unsupported content type: application/xml');
    const none = await parseBody(
      new Request('http://localhost/', { method: 'POST', body: new Uint8Array([1, 2]) }),
    ).catch((e) => e);
    expect(none).toBeInstanceOf(UnsupportedMediaTypeException);
  });

  test('an unsupported declared content type is rejected without reading the body', async () => {
    const req = post('<a/>', 'application/xml');
    await parseBody(req).catch(() => undefined);
    expect(req.bodyUsed).toBe(false);
  });

  test('a failing body stream is a 400', async () => {
    const failing = () =>
      new ReadableStream({
        start(c) {
          c.error(new Error('aborted'));
        },
      });
    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
      const req = new Request('http://localhost/', {
        method: 'POST',
        body: failing(),
        headers: { 'content-type': type },
        duplex: 'half',
      } as RequestInit);
      const error = (await parseBody(req).catch((e) => e)) as BadRequestException;
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.detail).toBe('Failed to read request body');
    }
  });
});
