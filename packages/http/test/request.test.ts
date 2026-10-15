import { describe, expect, test } from 'bun:test';
import { BadRequestException, UnsupportedMediaTypeException } from '../src/exceptions.js';
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

  test('prototype-polluting keys are plain data (Review Focus 5)', () => {
    const q = parseQuery(new URLSearchParams('__proto__=x&constructor=y&__proto__[polluted]=1'));
    expect(Object.getPrototypeOf(q)).toBeNull();
    expect(Object.hasOwn(q, '__proto__')).toBe(true);
    expect(Reflect.get(q, 'constructor')).toBe('y');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
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
      post('a=1&a=2&__proto__=x', 'application/x-www-form-urlencoded'),
    )) as object;
    expect(Object.getPrototypeOf(body)).toBeNull();
    expect(Object.entries(body)).toEqual([
      ['a', ['1', '2']],
      ['__proto__', 'x'],
    ]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
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
