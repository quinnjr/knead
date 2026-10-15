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

/** Maps a handler's return value to a Response (see spec §4.3). */
export function toResponse(value: unknown, status: number | undefined, headers: Headers): Response {
  if (value instanceof Response) return withHeaders(value, headers, false);
  if (value === undefined) return new Response(null, { status: status ?? 204, headers });
  const code = status ?? 200;
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
  headers.set('x-content-type-options', 'nosniff');
  return new Response(json, { status: code, headers });
}
