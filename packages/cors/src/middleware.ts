import { inject } from '@hpmws/core';
import { type Ctx, ForbiddenException, type Middleware, type Next, withHeaders } from '@hpmws/http';
import { CORS_OPTIONS } from './options.js';

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];
/** Longer Origin headers are treated as disallowed without consulting the configured rule. */
export const MAX_ORIGIN_LENGTH = 2048;

export function mergeVary(res: Response, values: readonly string[]): Response {
  if (values.length === 0) return res;
  const merged = new Map<string, string>();
  for (const v of (res.headers.get('vary') ?? '').split(',')) {
    const t = v.trim();
    if (t) merged.set(t.toLowerCase(), t);
  }
  for (const v of values) if (!merged.has(v.toLowerCase())) merged.set(v.toLowerCase(), v);
  return withHeaders(res, { vary: [...merged.values()].join(', ') });
}

export class CorsMiddleware implements Middleware {
  readonly #options = inject(CORS_OPTIONS);

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const o = this.#options;
    const origin = ctx.req.headers.get('origin');
    const wildcard = o.origin === '*';
    const vary = wildcard ? [] : ['Origin'];
    const allowed =
      origin !== null && origin.length <= MAX_ORIGIN_LENGTH && (await this.#matches(origin, ctx));
    // Browsers do not enforce CORS on WebSockets, so a cross-site page could otherwise open an
    // authenticated socket (cross-site WebSocket hijacking). Clients without Origin are not browsers.
    if (
      origin !== null &&
      !allowed &&
      ctx.req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    ) {
      throw new ForbiddenException('Origin not allowed for WebSocket upgrade');
    }
    const preflight =
      ctx.req.method === 'OPTIONS' && ctx.req.headers.has('access-control-request-method');

    if (preflight) {
      const headers = new Headers();
      if (allowed) {
        headers.set('access-control-allow-origin', wildcard ? '*' : origin);
        if (o.credentials) headers.set('access-control-allow-credentials', 'true');
        headers.set('access-control-allow-methods', (o.methods ?? DEFAULT_METHODS).join(', '));
        const requested = ctx.req.headers.get('access-control-request-headers');
        const allowHeaders = o.allowedHeaders ? o.allowedHeaders.join(', ') : requested;
        if (allowHeaders) headers.set('access-control-allow-headers', allowHeaders);
        if (o.maxAge !== undefined) headers.set('access-control-max-age', String(o.maxAge));
      }
      if (!o.allowedHeaders && !wildcard) vary.push('Access-Control-Request-Headers');
      if (vary.length > 0) headers.set('vary', vary.join(', '));
      return new Response(null, { status: 204, headers });
    }

    const res = await next();
    const headers = new Headers();
    if (allowed) {
      headers.set('access-control-allow-origin', wildcard ? '*' : origin);
      if (o.credentials) headers.set('access-control-allow-credentials', 'true');
      if (o.exposedHeaders?.length)
        headers.set('access-control-expose-headers', o.exposedHeaders.join(', '));
    }
    return mergeVary(withHeaders(res, headers), vary);
  }

  async #matches(origin: string, ctx: Ctx): Promise<boolean> {
    const rule = this.#options.origin;
    if (rule === '*') return true;
    if (typeof rule === 'string') return rule === origin;
    if (rule instanceof RegExp) {
      rule.lastIndex = 0;
      return rule.test(origin);
    }
    if (typeof rule === 'function') return rule(origin, ctx);
    return rule.includes(origin);
  }
}
