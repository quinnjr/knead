import { HttpConfigError } from '@knead-js/http';

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
  /** Seconds; a non-negative integer. Default 31536000 (one year). */
  maxAge?: number;
  /** Default true. */
  includeSubDomains?: boolean;
  /** Requires `includeSubDomains` and a `maxAge` of at least 31536000. */
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
  /** Default `camera=(), microphone=(), geolocation=(), interest-cohort=()`. */
  permissionsPolicy?: string | false;
  /** Default `none` (no Flash/PDF cross-domain policy files). */
  xPermittedCrossDomainPolicies?: 'none' | 'master-only' | 'by-content-type' | 'all' | false;
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
  permissionsPolicy: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  xPermittedCrossDomainPolicies: 'none',
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

const ONE_YEAR = 31_536_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_EXCEPT_TAB = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** Options whose value is sent as a header as is, with their header names for error messages. */
const HEADER_VALUES = [
  ['referrerPolicy', 'Referrer-Policy'],
  ['crossOriginOpenerPolicy', 'Cross-Origin-Opener-Policy'],
  ['crossOriginResourcePolicy', 'Cross-Origin-Resource-Policy'],
  ['xContentTypeOptions', 'X-Content-Type-Options'],
  ['xFrameOptions', 'X-Frame-Options'],
  ['xDnsPrefetchControl', 'X-DNS-Prefetch-Control'],
  ['permissionsPolicy', 'Permissions-Policy'],
  ['xPermittedCrossDomainPolicies', 'X-Permitted-Cross-Domain-Policies'],
] as const satisfies readonly (readonly [keyof SecurityHeadersOptions, string])[];

function validateHsts(hsts: HstsOptions | false | undefined): void {
  if (hsts === false || hsts === undefined) return;
  const maxAge = hsts.maxAge ?? ONE_YEAR;
  if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0) {
    throw new HttpConfigError(
      `HSTS maxAge must be a non-negative integer (seconds), got ${String(hsts.maxAge)}`,
    );
  }
  if (hsts.preload) {
    if (hsts.includeSubDomains === false) {
      throw new HttpConfigError('HSTS preload requires includeSubDomains.');
    }
    if (maxAge < ONE_YEAR) {
      throw new HttpConfigError(
        `HSTS preload requires maxAge >= ${ONE_YEAR} (one year), got ${maxAge}`,
      );
    }
  }
}

/**
 * Rejects CSP config that could inject extra directives or header lines, invalid HSTS (a
 * non-integer or negative maxAge, or preload without includeSubDomains and a one-year maxAge) and
 * header values that are not strings or contain control characters other than tab (CR, LF, NUL,
 * ...), which would otherwise fail every response.
 */
export function validateSecurityHeadersOptions(options: SecurityHeadersOptions): void {
  validateHsts(options.strictTransportSecurity);
  for (const [key, header] of HEADER_VALUES) {
    const value = options[key];
    if (value === undefined || value === false) continue;
    // Headers rejects CR, LF and NUL, which would fail every response instead of startup.
    if (typeof value !== 'string' || CONTROL_EXCEPT_TAB.test(value)) {
      throw new HttpConfigError(`Invalid ${header}: ${JSON.stringify(value)}`);
    }
  }
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
      if (typeof token !== 'string') {
        const label =
          typeof token === 'object' ? (token === null ? 'null' : 'object') : typeof token;
        throw new HttpConfigError(`Invalid CSP value for ${name}: expected a string, got ${label}`);
      }
      if (FORBIDDEN_TOKEN.test(token) || (typeof value !== 'string' && /\s/.test(token))) {
        throw new HttpConfigError(`Invalid CSP value for ${name}: ${JSON.stringify(token)}`);
      }
    }
  }
}
