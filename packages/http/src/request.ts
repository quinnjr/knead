import { BadRequestException, HttpException, UnsupportedMediaTypeException } from './exceptions.js';

type Fields<V> = Record<string, V | V[]>;

/** Default cap on query, urlencoded and multipart parameters (`listen({ maxParams })`). */
export const DEFAULT_MAX_PARAMS = 1000;

/** Keys dropped from parsed parameters and JSON bodies: they reshape objects they are merged into. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** More parameters than `maxParams`. */
class TooManyParams extends Error {}

function collect<V>(entries: Iterable<[string, V]>, maxParams: number): Fields<V> {
  // Null prototype, and the unsafe keys dropped: `Object.assign(target, fields)` stays plain data.
  const out = Object.create(null) as Fields<V>;
  let count = 0;
  for (const [key, value] of entries) {
    if (++count > maxParams) throw new TooManyParams();
    if (UNSAFE_KEYS.has(key)) continue;
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    // Pushed in place: copying the array on every repeat is quadratic in the number of repeats.
    else if (Array.isArray(previous)) previous.push(value);
    else out[key] = [previous, value];
  }
  return out;
}

/** Drops `__proto__` at every depth, and `constructor`/`prototype` when they hold an object. */
function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__') return undefined;
  if ((key === 'constructor' || key === 'prototype') && typeof value === 'object' && value !== null)
    return undefined;
  return value;
}

/** Collects a request body's fields; more than `maxParams` is a 413. */
function collectBody<V>(entries: Iterable<[string, V]>, maxParams: number): Fields<V> {
  try {
    return collect(entries, maxParams);
  } catch (error) {
    if (!(error instanceof TooManyParams)) throw error;
    throw new HttpException(413, `The request body has more than ${maxParams} fields.`);
  }
}

/**
 * The request URL. Bun gives a request whose Host header does not form a valid URL (for
 * example `Host: a b`) a relative `req.url`; that is resolved against a placeholder origin
 * (`http://host.invalid`) instead of throwing.
 */
export function requestUrl(req: Request): URL {
  return URL.canParse(req.url) ? new URL(req.url) : new URL(req.url, 'http://host.invalid');
}

/**
 * Query parameters as a null-prototype object (repeated keys become arrays; `__proto__`,
 * `constructor` and `prototype` are dropped). More than `maxParams` parameters is a 400.
 */
export function parseQuery(
  params: URLSearchParams,
  maxParams = DEFAULT_MAX_PARAMS,
): Record<string, string | string[]> {
  try {
    return collect(params, maxParams);
  } catch (error) {
    if (!(error instanceof TooManyParams)) throw error;
    throw new BadRequestException(`The query string has more than ${maxParams} parameters.`);
  }
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of headers) out[key] = value;
  return out;
}

async function readBody<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new BadRequestException('Failed to read request body');
  }
}

/**
 * Parses a JSON, urlencoded, multipart or text body. JSON drops `__proto__` keys (and
 * `constructor`/`prototype` keys holding objects) at every depth; forms drop the same keys and
 * answer 413 beyond `maxParams` fields.
 */
export async function parseBody(req: Request, maxParams = DEFAULT_MAX_PARAMS): Promise<unknown> {
  if (req.body === null) return undefined;
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    const text = await readBody(() => req.text());
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text, safeReviver);
    } catch {
      throw new BadRequestException('Malformed JSON body');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return collectBody(new URLSearchParams(await readBody(() => req.text())), maxParams);
  }
  if (type === 'multipart/form-data') {
    let form: Iterable<[string, string | File]>;
    try {
      form = (await req.formData()) as unknown as Iterable<[string, string | File]>;
    } catch {
      throw new BadRequestException('Malformed multipart body');
    }
    return collectBody(form, maxParams);
  }
  if (type.startsWith('text/')) return readBody(() => req.text());
  // Declared but unsupported: reject without consuming the body.
  if (type) throw new UnsupportedMediaTypeException(`Unsupported content type: ${type}`);
  const bytes = await readBody(() => req.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  throw new UnsupportedMediaTypeException('Unsupported content type: (none)');
}
