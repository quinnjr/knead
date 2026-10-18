import { Injectable, InjectionToken, inject } from '@knead-js/core';
import {
  type Ctx,
  createRouteDecorator,
  LOGGER,
  type Middleware,
  type Next,
  withHeaders,
} from '@knead-js/http';
import {
  type CompiledValue,
  compileHeaders,
  generateNonce,
  nonceTargets,
  withNonce,
} from './csp.js';
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

/** Effective options with their header lists, built on first use for plain and secure requests. */
interface Compiled {
  readonly options: SecurityHeadersOptions;
  /** Whether requests get a nonce (the CSP has nonce targets). */
  readonly nonce: boolean;
  plain?: [string, CompiledValue][];
  secure?: [string, CompiledValue][];
}

const override = createRouteDecorator<SecurityHeadersOptions>(SECURITY_HEADERS_META);

/** Per-controller or per-route overrides merged over the module options. */
export function SecurityHeaders(options: SecurityHeadersOptions) {
  validateSecurityHeadersOptions(options);
  return override(options);
}

@Injectable()
export class SecurityHeadersMiddleware implements Middleware {
  readonly #options = SecurityHeadersMiddleware.#validated(
    mergeOptions(DEFAULT_OPTIONS, inject(SECURITY_HEADERS_OPTIONS)),
  );

  static #validated(options: SecurityHeadersOptions): SecurityHeadersOptions {
    validateSecurityHeadersOptions(options);
    return options;
  }
  readonly #default = compiled(this.#options);
  /** Per route override object. */
  readonly #overrides = new WeakMap<object, Compiled>();
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
    const entry = this.#effective(ctx);
    const nonce = entry.nonce ? generateNonce() : undefined;
    if (nonce) ctx.state.cspNonce = nonce;
    const res = await next();
    const key = ctx.secure ? 'secure' : 'plain';
    entry[key] ??= compileHeaders(entry.options, ctx.secure);
    const headers = entry[key];
    // Without a nonce no value has nonce slots, so the list is sent as built.
    return withHeaders(
      res,
      nonce ? withNonce(headers, nonce) : (headers as [string, string][]),
      false,
    );
  }

  #effective(ctx: Ctx): Compiled {
    const routeOverride = ctx.route?.meta[SECURITY_HEADERS_META] as
      | SecurityHeadersOptions
      | undefined;
    if (!routeOverride) return this.#default;
    let entry = this.#overrides.get(routeOverride);
    if (!entry) {
      entry = compiled(mergeOptions(this.#options, routeOverride));
      this.#overrides.set(routeOverride, entry);
      this.#checkHsts(entry.options);
    }
    return entry;
  }
}

function compiled(options: SecurityHeadersOptions): Compiled {
  return { options, nonce: nonceTargets(options.contentSecurityPolicy) !== undefined };
}
