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

/**
 * Text that may hold an unsafe key: `__proto__`, `constructor` or `prototype` written out, or a
 * `\u00XX` escape of a printable ASCII character (which could spell any letter of them, such as
 * `\u005f`, `\u0063` or `\u0070`, or `c\u006fnstructor`). Escapes of non-ASCII and control
 * characters (Python's `ensure_ascii` output) stay on the fast path.
 */
const UNSAFE_JSON = /__proto__|constructor|prototype|\\u00[2-7][0-9a-f]/i;

/** Drops `__proto__` at every depth, and `constructor`/`prototype` when they hold an object. */
function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__') return undefined;
  if ((key === 'constructor' || key === 'prototype') && typeof value === 'object' && value !== null)
    return undefined;
  return value;
}

/**
 * Whether `text` (a query string or urlencoded body) has more than `max` non-empty `&`-separated
 * fields. Stops counting past `max`, so oversized input is rejected before it is parsed.
 */
function exceedsFields(text: string, max: number): boolean {
  let count = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('&', start);
    if (end === -1) end = text.length;
    if (end > start && ++count > max) return true;
    start = end + 1;
  }
  return false;
}

/** Occurrences of `needle` in `bytes`, counting no further than `limit`. Linear (indexOf). */
function countOccurrences(bytes: Buffer, needle: string, limit: number): number {
  const pattern = Buffer.from(needle, 'latin1');
  let count = 0;
  for (let at = bytes.indexOf(pattern); at !== -1 && count < limit; ) {
    count++;
    at = bytes.indexOf(pattern, at + pattern.length);
  }
  return count;
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

const pathnames = new WeakMap<Request, string>();

/**
 * @internal `requestUrl(req).pathname`, parsed once per request: the fetch fallback, its 405
 * detection and error responses all need it.
 */
export function requestPathname(req: Request): string {
  let pathname = pathnames.get(req);
  if (pathname === undefined) {
    pathname = requestUrl(req).pathname;
    pathnames.set(req, pathname);
  }
  return pathname;
}

/**
 * Query parameters as a null-prototype object (repeated keys become arrays; `__proto__`,
 * `constructor` and `prototype` are dropped). More than `maxParams` parameters is a 400; given
 * the raw query string, that is detected before it is parsed.
 */
export function parseQuery(
  params: URLSearchParams | string,
  maxParams = DEFAULT_MAX_PARAMS,
): Record<string, string | string[]> {
  if (typeof params === 'string') {
    const search = params.startsWith('?') ? params.slice(1) : params;
    if (exceedsFields(search, maxParams)) {
      throw new BadRequestException(`The query string has more than ${maxParams} parameters.`);
    }
    params = new URLSearchParams(search);
  }
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
      // The reviver costs several times a plain parse, so it runs only when an unsafe key could
      // be present (directly, or spelled with a \u escape).
      return UNSAFE_JSON.test(text) ? JSON.parse(text, safeReviver) : JSON.parse(text);
    } catch {
      throw new BadRequestException('Malformed JSON body');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const text = await readBody(() => req.text());
    if (exceedsFields(text, maxParams)) {
      throw new HttpException(413, `The request body has more than ${maxParams} fields.`);
    }
    return collectBody(new URLSearchParams(text), maxParams);
  }
  if (type === 'multipart/form-data') {
    const contentType = req.headers.get('content-type') ?? '';
    // The body is already capped at maxRequestBodySize: buffer it and count its parts before
    // the multipart parser builds them all.
    const bytes = Buffer.from(await readBody(() => req.arrayBuffer()));
    const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    const delimiter = boundary ? `--${boundary[1] ?? boundary[2]}` : undefined;
    if (delimiter && countOccurrences(bytes, delimiter, maxParams + 2) - 1 > maxParams) {
      throw new HttpException(413, `The request body has more than ${maxParams} fields.`);
    }
    let form: Iterable<[string, string | File]>;
    try {
      form = (await new Response(bytes, {
        headers: { 'content-type': contentType },
      }).formData()) as unknown as Iterable<[string, string | File]>;
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
