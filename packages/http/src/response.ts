/** Whether `value` can be set as a header value (no CR, LF or NUL, Latin-1 only). */
export function isHeaderValue(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  try {
    new Headers({ 'cache-control': value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds headers to a response. If the response's headers are immutable, the response is
 * re-wrapped. `set-cookie` values are appended. With `overwrite = false`, headers already
 * present on the response win.
 */
export function withHeaders(res: Response, headers: Bun.HeadersInit, overwrite = true): Response {
  const entries = [...new Headers(headers)];
  if (entries.length === 0) return res;
  const apply = (target: Headers) => {
    for (const [key, value] of entries) {
      if (key === 'set-cookie') target.append(key, value);
      else if (overwrite || !target.has(key)) target.set(key, value);
    }
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    apply(copy.headers);
    return copy;
  }
}

function binary(body: Bun.BodyInit, status: number, headers: Headers, type?: string): Response {
  if (!headers.has('content-type')) headers.set('content-type', type || 'application/octet-stream');
  return new Response(body, { status, headers });
}

/** Statuses whose responses never have a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Maps a handler's return value to a Response (see spec §4.3). Every response built here carries
 * `x-content-type-options: nosniff`; with a 204, 205 or 304 status the value is dropped and the
 * response has no body. A Response returned by the handler keeps its status, body and headers;
 * the headers set on `ctx.res.headers` are added where it has none of its own (`set-cookie` is
 * appended), and `listen({ defaultCacheControl })` applies when it has no Cache-Control.
 */
export function toResponse(value: unknown, status: number | undefined, headers: Headers): Response {
  if (value instanceof Response) return withHeaders(value, headers, false);
  headers.set('x-content-type-options', 'nosniff');
  if (value === undefined) return new Response(null, { status: status ?? 204, headers });
  const code = status ?? 200;
  if (NULL_BODY_STATUSES.has(code)) {
    // A dropped stream is cancelled, so its source can release what it holds.
    if (value instanceof ReadableStream && !value.locked) void value.cancel().catch(() => {});
    return new Response(null, { status: code, headers });
  }
  if (typeof value === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(value, { status: code, headers });
  }
  if (value instanceof Blob) return binary(value, code, headers, value.type);
  if (
    value instanceof ReadableStream ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return binary(value as Bun.BodyInit, code, headers);
  }
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError('Handler returned a value that cannot be serialized as JSON');
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(json, { status: code, headers });
}
