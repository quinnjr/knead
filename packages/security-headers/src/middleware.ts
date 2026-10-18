import {
  getMetadata,
  getMethodMetadata,
  Injectable,
  InjectionToken,
  inject,
  MODULES,
  type ModuleRef,
} from '@knead-js/core';
import {
  CONTROLLER,
  type Ctx,
  createRouteDecorator,
  HttpConfigError,
  LOGGER,
  type Middleware,
  type Next,
  ROUTE_META,
  ROUTES,
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
    // Each override was validated alone; validate (and compile) its merge with the module options
    // now, so a combination such as a route `preload` over a short module maxAge fails startup.
    for (const [label, routeOverride] of routeOverrides(inject(MODULES, { optional: true }))) {
      try {
        this.#entry(routeOverride);
      } catch (error) {
        if (!(error instanceof HttpConfigError)) throw error;
        throw new HttpConfigError(
          `@SecurityHeaders() on ${label}, merged with the module options: ${error.message}`,
        );
      }
    }
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
    return this.#entry(routeOverride);
  }

  /**
   * The compiled merge of the module options and a route override, validated before it is cached.
   * Overrides on controller routes are built at construction; any other is built on first use.
   */
  #entry(routeOverride: SecurityHeadersOptions): Compiled {
    let entry = this.#overrides.get(routeOverride);
    if (!entry) {
      entry = compiled(
        SecurityHeadersMiddleware.#validated(mergeOptions(this.#options, routeOverride)),
      );
      this.#overrides.set(routeOverride, entry);
      this.#checkHsts(entry.options);
    }
    return entry;
  }
}

function compiled(options: SecurityHeadersOptions): Compiled {
  return { options, nonce: nonceTargets(options.contentSecurityPolicy) !== undefined };
}

/**
 * The `@SecurityHeaders()` override of every controller route, labelled `Controller.method`. The
 * route metadata is merged as the HTTP compiler merges it: controller `meta`, controller
 * decorators, route `meta`, then method decorators.
 */
function* routeOverrides(
  modules: readonly ModuleRef[] | undefined,
): Generator<[string, SecurityHeadersOptions]> {
  for (const mod of modules ?? []) {
    for (const controller of mod.controllers) {
      const ctrlMeta = {
        ...(getMetadata(controller, CONTROLLER)?.options.meta ?? {}),
        ...(getMetadata(controller, ROUTE_META) ?? {}),
      };
      for (const route of getMetadata(controller, ROUTES) ?? []) {
        const meta = {
          ...ctrlMeta,
          ...(route.options.meta ?? {}),
          ...(getMethodMetadata(controller, route.handler, ROUTE_META) ?? {}),
        };
        const value = meta[SECURITY_HEADERS_META] as SecurityHeadersOptions | undefined;
        if (value) yield [`${controller.name}.${String(route.handler)}`, value];
      }
    }
  }
}
