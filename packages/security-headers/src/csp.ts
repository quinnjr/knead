import type { CspDirectives, CspOptions, SecurityHeadersOptions } from './options.js';

export interface NonceTargets {
  scripts: boolean;
  styles: boolean;
}

export function nonceTargets(csp: CspOptions | false | undefined): NonceTargets | undefined {
  if (csp === false || csp === undefined) return undefined;
  const nonce = csp.nonce;
  if (!nonce) return undefined;
  if (nonce === true) return { scripts: true, styles: false };
  return { scripts: nonce.scripts ?? true, styles: nonce.styles ?? false };
}

/** Where the nonce token goes in a compiled CSP. */
const NONCE = Symbol('nonce');

/**
 * A header value split where the CSP nonce token goes: `parts.join(\`'nonce-${nonce}'\`)` is the
 * value for a request. A value without a nonce slot is a single part.
 */
export type CompiledValue = string | readonly string[];

/** The CSP text as parts between nonce tokens (one part when `targets` is undefined). */
function cspParts(directives: CspDirectives, targets: NonceTargets | undefined): string[] {
  const d = new Map<string, (string | typeof NONCE)[] | true>();
  for (const [name, value] of Object.entries(directives)) {
    if (value === false) continue;
    d.set(
      name,
      value === true
        ? true
        : typeof value === 'string'
          ? value.split(/\s+/).filter(Boolean)
          : [...value],
    );
  }
  if (targets) {
    const extend = (name: string) => {
      const current = d.get(name);
      const fallback = d.get('default-src');
      // Only an absent directive falls back to default-src: one set to true has no sources.
      const base =
        current === true
          ? []
          : Array.isArray(current)
            ? current
            : Array.isArray(fallback)
              ? [...fallback]
              : [];
      d.set(name, [...base, NONCE]);
    };
    if (targets.scripts) extend('script-src');
    if (targets.styles) extend('style-src');
  }
  const parts = [''];
  let first = true;
  for (const [name, value] of d) {
    parts[parts.length - 1] += first ? name : `; ${name}`;
    first = false;
    if (value === true) continue;
    parts[parts.length - 1] += ' ';
    value.forEach((token, i) => {
      if (i > 0) parts[parts.length - 1] += ' ';
      if (token === NONCE) parts.push('');
      else parts[parts.length - 1] += token;
    });
  }
  return parts;
}

export function serializeCsp(
  directives: CspDirectives,
  nonce?: string,
  targets: NonceTargets = { scripts: true, styles: false },
): string {
  return cspParts(directives, nonce ? targets : undefined).join(`'nonce-${nonce}'`);
}

/**
 * @internal The headers of buildHeaders() for every request with the same options and secure
 * flag. With `nonces`, the CSP value is split where the nonce tokens go (see CompiledValue).
 */
export function compileHeaders(
  options: SecurityHeadersOptions,
  secure: boolean,
  nonces = true,
): [string, CompiledValue][] {
  const out: [string, CompiledValue][] = [];
  const csp = options.contentSecurityPolicy;
  if (csp) {
    const parts = cspParts(csp.directives ?? {}, nonces ? nonceTargets(csp) : undefined);
    out.push([
      csp.reportOnly ? 'content-security-policy-report-only' : 'content-security-policy',
      parts.length === 1 ? parts[0]! : parts,
    ]);
  }
  const hsts = options.strictTransportSecurity;
  if (hsts && secure) {
    let value = `max-age=${hsts.maxAge ?? 31_536_000}`;
    if (hsts.includeSubDomains ?? true) value += '; includeSubDomains';
    if (hsts.preload) value += '; preload';
    out.push(['strict-transport-security', value]);
  }
  const simple: [string, string | false | undefined][] = [
    ['x-content-type-options', options.xContentTypeOptions],
    ['referrer-policy', options.referrerPolicy],
    ['cross-origin-opener-policy', options.crossOriginOpenerPolicy],
    ['cross-origin-resource-policy', options.crossOriginResourcePolicy],
    ['x-frame-options', options.xFrameOptions],
    ['x-dns-prefetch-control', options.xDnsPrefetchControl],
    ['permissions-policy', options.permissionsPolicy],
    ['x-permitted-cross-domain-policies', options.xPermittedCrossDomainPolicies],
  ];
  for (const [name, value] of simple) if (value) out.push([name, value]);
  return out;
}

/** @internal A compiled header list with `nonce` in its slots. */
export function withNonce(
  compiled: readonly [string, CompiledValue][],
  nonce: string,
): [string, string][] {
  const token = `'nonce-${nonce}'`;
  return compiled.map(([name, value]) => [
    name,
    typeof value === 'string' ? value : value.join(token),
  ]);
}

export function buildHeaders(
  options: SecurityHeadersOptions,
  request: { secure: boolean; nonce?: string | undefined },
): [string, string][] {
  const compiled = compileHeaders(options, request.secure, Boolean(request.nonce));
  return request.nonce ? withNonce(compiled, request.nonce) : (compiled as [string, string][]);
}

export function generateNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}
