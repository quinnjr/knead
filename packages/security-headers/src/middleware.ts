import { InjectionToken, inject } from '@knead-js/core';
import {
  type Ctx,
  createRouteDecorator,
  LOGGER,
  type Middleware,
  type Next,
  withHeaders,
} from '@knead-js/http';
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
export const SECURITY_HEADERS_META = Symbol('knead:security-headers');

/** The shortest HSTS max-age that does not log a warning: 180 days. */
export const MIN_RECOMMENDED_HSTS_MAX_AGE = 15_552_000;

/**
 * Stands in for the nonce when a header list is built ahead of time. Validation rejects line
 * feeds in every CSP token, so it can only appear where the nonce goes.
 */
const NONCE_SLOT = '\n';

/** A built header list; a value with nonce slots is kept as the parts between them. */
type CompiledHeaders = readonly (readonly [string, string | readonly string[]])[];

const override = createRouteDecorator<SecurityHeadersOptions>(SECURITY_HEADERS_META);

/** Per-controller or per-route overrides merged over the module options. */
export function SecurityHeaders(options: SecurityHeadersOptions) {
  validateSecurityHeadersOptions(options);
  return override(options);
}

export class SecurityHeadersMiddleware implements Middleware {
  readonly #options = SecurityHeadersMiddleware.#validated(
    mergeOptions(DEFAULT_OPTIONS, inject(SECURITY_HEADERS_OPTIONS)),
  );

  static #validated(options: SecurityHeadersOptions): SecurityHeadersOptions {
    validateSecurityHeadersOptions(options);
    return options;
  }
  readonly #cache = new WeakMap<object, SecurityHeadersOptions>();
  /** Built headers per effective options object, for plain and secure requests. */
  readonly #compiled = new WeakMap<
    SecurityHeadersOptions,
    { plain?: CompiledHeaders; secure?: CompiledHeaders }
  >();
  readonly #logger = inject(LOGGER, { optional: true });
  #warnedShortHsts = false;

  constructor() {
    this.#checkHsts(this.#options);
  }

  /** Logs once when HSTS is on with a max-age shorter than 180 days (15552000 seconds). */
  #checkHsts(options: SecurityHeadersOptions): void {
    const hsts = options.strictTransportSecurity;
    if (this.#warnedShortHsts || !hsts) return;
    const maxAge = hsts.maxAge ?? 31_536_000;
    if (maxAge > 0 && maxAge < MIN_RECOMMENDED_HSTS_MAX_AGE) {
      this.#warnedShortHsts = true;
      this.#logger?.warn(
        `HSTS max-age is ${maxAge}s, shorter than 180 days (${MIN_RECOMMENDED_HSTS_MAX_AGE}s): ` +
          'browsers forget the policy quickly, reopening the downgrade window. Use at least ' +
          '15552000, ideally 31536000.',
      );
    }
  }

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const options = this.#effective(ctx);
    const nonce = nonceTargets(options.contentSecurityPolicy) ? generateNonce() : undefined;
    if (nonce) ctx.state.cspNonce = nonce;
    const res = await next();
    return withHeaders(res, this.#headers(options, ctx.secure, nonce), false);
  }

  /** The same list as buildHeaders(), built once per options and secure flag; only the nonce varies. */
  #headers(options: SecurityHeadersOptions, secure: boolean, nonce: string | undefined) {
    let entry = this.#compiled.get(options);
    if (!entry) {
      entry = {};
      this.#compiled.set(options, entry);
    }
    const key = secure ? 'secure' : 'plain';
    let compiled = entry[key];
    if (!compiled) {
      const slot = nonceTargets(options.contentSecurityPolicy) ? NONCE_SLOT : undefined;
      compiled = buildHeaders(options, { secure, nonce: slot }).map(
        ([name, value]) =>
          [name, slot && value.includes(slot) ? value.split(slot) : value] as const,
      );
      entry[key] = compiled;
    }
    return compiled.map(([name, value]): [string, string] => [
      name,
      typeof value === 'string' ? value : value.join(nonce ?? ''),
    ]);
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
      this.#checkHsts(merged);
    }
    return merged;
  }
}
