import { BadRequestException, UnsupportedMediaTypeException } from './exceptions.js';

type Fields<V> = Record<string, V | V[]>;

function collect<V>(entries: Iterable<[string, V]>): Fields<V> {
  // Null prototype: keys such as "__proto__" stay plain data.
  const out = Object.create(null) as Fields<V>;
  for (const [key, value] of entries) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else out[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

export function parseQuery(params: URLSearchParams): Record<string, string | string[]> {
  return collect(params);
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of headers) out[key] = value;
  return out;
}

export async function parseBody(req: Request): Promise<unknown> {
  if (req.body === null) return undefined;
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    const text = await req.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new BadRequestException('Malformed JSON body');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return parseQuery(new URLSearchParams(await req.text()));
  }
  if (type === 'multipart/form-data') {
    let form: Iterable<[string, string | File]>;
    try {
      form = (await req.formData()) as unknown as Iterable<[string, string | File]>;
    } catch {
      throw new BadRequestException('Malformed multipart body');
    }
    return collect(form);
  }
  if (type.startsWith('text/')) return req.text();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return undefined;
  throw new UnsupportedMediaTypeException(`Unsupported content type: ${type || '(none)'}`);
}
