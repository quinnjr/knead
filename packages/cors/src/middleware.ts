import { Injectable, inject } from '@knead-js/core';
import {
  type Ctx,
  ForbiddenException,
  type Middleware,
  type Next,
  withHeaders,
} from '@knead-js/http';
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

@Injectable()
export class CorsMiddleware implements Middleware {
  readonly #options = inject(CORS_OPTIONS);
  // Everything that does not depend on the request is built once.
  readonly #wildcard = this.#options.origin === '*';
  readonly #origins: ReadonlySet<string> | undefined = Array.isArray(this.#options.origin)
    ? new Set(this.#options.origin)
    : undefined;
  readonly #methods = (this.#options.methods ?? DEFAULT_METHODS).join(', ');
  readonly #allowHeaders = this.#options.allowedHeaders?.join(', ');
  readonly #exposeHeaders = this.#options.exposedHeaders?.length
    ? this.#options.exposedHeaders.join(', ')
    : undefined;
  readonly #maxAge = this.#options.maxAge === undefined ? undefined : String(this.#options.maxAge);
  readonly #vary: readonly string[] = this.#wildcard ? [] : ['Origin'];
  readonly #preflightVary = [
    ...this.#vary,
    ...(this.#allowHeaders === undefined ? ['Access-Control-Request-Headers'] : []),
  ].join(', ');

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const o = this.#options;
    const origin = ctx.req.headers.get('origin');
    const wildcard = this.#wildcard;
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
        headers.set('access-control-allow-methods', this.#methods);
        const allowHeaders =
          this.#allowHeaders ?? ctx.req.headers.get('access-control-request-headers');
        if (allowHeaders) headers.set('access-control-allow-headers', allowHeaders);
        if (this.#maxAge !== undefined) headers.set('access-control-max-age', this.#maxAge);
      }
      if (this.#preflightVary) headers.set('vary', this.#preflightVary);
      return new Response(null, { status: 204, headers });
    }

    const res = await next();
    const headers = new Headers();
    if (allowed) {
      headers.set('access-control-allow-origin', wildcard ? '*' : origin);
      if (o.credentials) headers.set('access-control-allow-credentials', 'true');
      if (this.#exposeHeaders) headers.set('access-control-expose-headers', this.#exposeHeaders);
    }
    return mergeVary(withHeaders(res, headers), this.#vary);
  }

  async #matches(origin: string, ctx: Ctx): Promise<boolean> {
    const rule = this.#options.origin;
    if (rule === '*') return true;
    if (typeof rule === 'string') return rule === origin;
    if (rule instanceof RegExp) {
      rule.lastIndex = 0;
      return rule.test(origin);
    }
    // Fail closed: only a literal true (or a promise of one) allows the origin.
    if (typeof rule === 'function') return (await rule(origin, ctx)) === true;
    return this.#origins?.has(origin) === true;
  }
}
