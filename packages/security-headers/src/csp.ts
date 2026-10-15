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

export function serializeCsp(
  directives: CspDirectives,
  nonce?: string,
  targets: NonceTargets = { scripts: true, styles: false },
): string {
  const d = new Map<string, string[] | true>();
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
  if (nonce) {
    const token = `'nonce-${nonce}'`;
    const extend = (name: string) => {
      const current = d.get(name);
      const fallback = d.get('default-src');
      const base = Array.isArray(current) ? current : Array.isArray(fallback) ? [...fallback] : [];
      d.set(name, [...base, token]);
    };
    if (targets.scripts) extend('script-src');
    if (targets.styles) extend('style-src');
  }
  return [...d]
    .map(([name, value]) => (value === true ? name : `${name} ${value.join(' ')}`))
    .join('; ');
}

export function buildHeaders(
  options: SecurityHeadersOptions,
  request: { secure: boolean; nonce?: string | undefined },
): [string, string][] {
  const out: [string, string][] = [];
  const csp = options.contentSecurityPolicy;
  if (csp) {
    const targets = nonceTargets(csp);
    out.push([
      csp.reportOnly ? 'content-security-policy-report-only' : 'content-security-policy',
      serializeCsp(csp.directives ?? {}, targets ? request.nonce : undefined, targets),
    ]);
  }
  const hsts = options.strictTransportSecurity;
  if (hsts && request.secure) {
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
  ];
  for (const [name, value] of simple) if (value) out.push([name, value]);
  return out;
}

export function generateNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}
