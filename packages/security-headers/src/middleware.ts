import { InjectionToken, inject } from '@hpmws/core';
import {
  type Ctx,
  createRouteDecorator,
  type Middleware,
  type Next,
  withHeaders,
} from '@hpmws/http';
import { buildHeaders, generateNonce, nonceTargets } from './csp.js';
import {
  DEFAULT_OPTIONS,
  mergeOptions,
  type SecurityHeadersOptions,
  validateSecurityHeadersOptions,
} from './options.js';

export const SECURITY_HEADERS_OPTIONS = new InjectionToken<SecurityHeadersOptions>(
  'SECURITY_HEADERS_OPTIONS',
);
export const SECURITY_HEADERS_META = Symbol('hpmws:security-headers');

const override = createRouteDecorator<SecurityHeadersOptions>(SECURITY_HEADERS_META);

/** Per-controller or per-route overrides merged over the module options. */
export function SecurityHeaders(options: SecurityHeadersOptions) {
  validateSecurityHeadersOptions(options);
  return override(options);
}

export class SecurityHeadersMiddleware implements Middleware {
  readonly #options = mergeOptions(DEFAULT_OPTIONS, inject(SECURITY_HEADERS_OPTIONS));
  readonly #cache = new WeakMap<object, SecurityHeadersOptions>();

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const options = this.#effective(ctx);
    const nonce = nonceTargets(options.contentSecurityPolicy) ? generateNonce() : undefined;
    if (nonce) ctx.state.cspNonce = nonce;
    const res = await next();
    return withHeaders(res, buildHeaders(options, { secure: ctx.secure, nonce }), false);
  }

  #effective(ctx: Ctx): SecurityHeadersOptions {
    const routeOverride = ctx.route?.meta[SECURITY_HEADERS_META] as
      | SecurityHeadersOptions
      | undefined;
    if (!routeOverride) return this.#options;
    let merged = this.#cache.get(routeOverride);
    if (!merged) {
      merged = mergeOptions(this.#options, routeOverride);
      this.#cache.set(routeOverride, merged);
    }
    return merged;
  }
}
