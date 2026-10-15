export type CspDirectives = Record<string, readonly string[] | string | boolean>;

export interface CspOptions {
  /** Merged over the defaults. `false` removes a directive, `true` emits a value-less directive. */
  directives?: CspDirectives;
  reportOnly?: boolean;
  /** Per-request nonce in ctx.state.cspNonce, appended to script-src (and style-src if enabled). */
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
