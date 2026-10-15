import { HttpConfigError } from '@hpmws/http';

/** Directive names must be lowercase (e.g. `script-src`); anything else is rejected at validation. */
export type CspDirectives = Record<string, readonly string[] | string | boolean>;

export interface CspOptions {
  /** Merged over the defaults. `false` removes a directive, `true` emits a value-less directive. */
  directives?: CspDirectives;
  reportOnly?: boolean;
  /**
   * Per-request nonce in ctx.state.cspNonce, appended to script-src (and style-src if enabled).
   * When the target directive is absent and default-src is absent or `true`, the directive
   * becomes the nonce alone (strict: nothing else is allowed). Set the directive explicitly
   * to allow more.
   */
  nonce?: boolean | { scripts?: boolean; styles?: boolean };
}

export interface HstsOptions {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: CspOptions | false;
  /** Only ever sent on secure requests (ctx.secure). */
  strictTransportSecurity?: HstsOptions | false;
  xContentTypeOptions?: 'nosniff' | false;
  referrerPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  xDnsPrefetchControl?: 'on' | 'off' | false;
}

export const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': true,
};

export const DEFAULT_OPTIONS: SecurityHeadersOptions = {
  contentSecurityPolicy: { directives: DEFAULT_CSP_DIRECTIVES },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
  xFrameOptions: 'DENY',
  xDnsPrefetchControl: 'off',
};

function mergeCsp(
  a: CspOptions | false | undefined,
  b: CspOptions | false | undefined,
): CspOptions | false | undefined {
  if (b === undefined) return a;
  if (b === false) return false;
  const base = a === false || a === undefined ? { directives: DEFAULT_CSP_DIRECTIVES } : a;
  return { ...base, ...b, directives: { ...(base.directives ?? {}), ...(b.directives ?? {}) } };
}

function mergeHsts(
  a: HstsOptions | false | undefined,
  b: HstsOptions | false | undefined,
): HstsOptions | false | undefined {
  if (b === undefined) return a;
  if (b === false) return false;
  return { ...(a === false || a === undefined ? {} : a), ...b };
}

export function mergeOptions(
  a: SecurityHeadersOptions,
  b: SecurityHeadersOptions,
): SecurityHeadersOptions {
  const out: SecurityHeadersOptions = { ...a };
  for (const [key, value] of Object.entries(b) as [keyof SecurityHeadersOptions, unknown][]) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  out.contentSecurityPolicy = mergeCsp(a.contentSecurityPolicy, b.contentSecurityPolicy);
  out.strictTransportSecurity = mergeHsts(a.strictTransportSecurity, b.strictTransportSecurity);
  return out;
}

const DIRECTIVE_NAME = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_TOKEN = /[;,\r\n]/;

/** Rejects CSP config that could inject extra directives or header lines. */
export function validateSecurityHeadersOptions(options: SecurityHeadersOptions): void {
  const csp = options.contentSecurityPolicy;
  if (csp === false || csp === undefined || !csp.directives) return;
  for (const [name, value] of Object.entries(csp.directives)) {
    if (!DIRECTIVE_NAME.test(name))
      throw new HttpConfigError(`Invalid CSP directive name: ${JSON.stringify(name)}`);
    if (typeof value === 'boolean') continue;
    if (typeof value !== 'string' && !Array.isArray(value))
      throw new HttpConfigError(
        `Invalid CSP value for ${name}: expected a string, string array or boolean, got ${value === null ? 'null' : typeof value}`,
      );
    const tokens: readonly string[] = typeof value === 'string' ? [value] : value;
    for (const token of tokens) {
      if (typeof token !== 'string')
        throw new HttpConfigError(`Invalid CSP value for ${name}: ${JSON.stringify(token)}`);
      if (FORBIDDEN_TOKEN.test(token) || (typeof value !== 'string' && /\s/.test(token))) {
        throw new HttpConfigError(`Invalid CSP value for ${name}: ${JSON.stringify(token)}`);
      }
    }
  }
}
