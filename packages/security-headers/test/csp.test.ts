import { describe, expect, test } from 'bun:test';
import { HttpConfigError } from '@hpmws/http';
import {
  buildHeaders,
  DEFAULT_CSP_DIRECTIVES,
  DEFAULT_OPTIONS,
  mergeOptions,
  serializeCsp,
  validateSecurityHeadersOptions,
} from '../src/index.js';

describe('serializeCsp', () => {
  test('defaults serialize in declaration order', () => {
    expect(serializeCsp(DEFAULT_CSP_DIRECTIVES)).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
    );
  });

  test('false removes a directive; strings are split', () => {
    expect(
      serializeCsp({ 'default-src': "'self' https:", 'upgrade-insecure-requests': false }),
    ).toBe("default-src 'self' https:");
  });

  test('nonces extend script-src (copied from default-src when absent) and optionally style-src', () => {
    expect(
      serializeCsp({ 'default-src': ["'self'"] }, 'abc', { scripts: true, styles: true }),
    ).toBe("default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self' 'nonce-abc'");
    expect(
      serializeCsp({ 'script-src': ["'self'"] }, 'abc', { scripts: true, styles: false }),
    ).toBe("script-src 'self' 'nonce-abc'");
  });
});

describe('mergeOptions and buildHeaders', () => {
  test('directives merge; false disables a header; HSTS only when secure', () => {
    const merged = mergeOptions(DEFAULT_OPTIONS, {
      contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'] } },
      xDnsPrefetchControl: false,
    });
    const insecure = Object.fromEntries(buildHeaders(merged, { secure: false }));
    expect(insecure['content-security-policy']).toContain("img-src 'self' data:");
    expect(insecure['content-security-policy']).toContain("default-src 'self'");
    expect(insecure['x-dns-prefetch-control']).toBeUndefined();
    expect(insecure['strict-transport-security']).toBeUndefined();
    const secure = Object.fromEntries(buildHeaders(merged, { secure: true }));
    expect(secure['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  test('reportOnly switches the header name; csp false removes it', () => {
    const reportOnly = Object.fromEntries(
      buildHeaders(mergeOptions(DEFAULT_OPTIONS, { contentSecurityPolicy: { reportOnly: true } }), {
        secure: false,
      }),
    );
    expect(reportOnly['content-security-policy-report-only']).toBeDefined();
    expect(reportOnly['content-security-policy']).toBeUndefined();
    const none = Object.fromEntries(
      buildHeaders(mergeOptions(DEFAULT_OPTIONS, { contentSecurityPolicy: false }), {
        secure: false,
      }),
    );
    expect(none['content-security-policy']).toBeUndefined();
  });

  test('HSTS preload', () => {
    const h = Object.fromEntries(
      buildHeaders(
        mergeOptions(DEFAULT_OPTIONS, {
          strictTransportSecurity: { maxAge: 63072000, preload: true },
        }),
        {
          secure: true,
        },
      ),
    );
    expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
  });
});

describe('validateSecurityHeadersOptions', () => {
  const csp = (directives: Record<string, readonly string[] | string | boolean>) => ({
    contentSecurityPolicy: { directives },
  });

  test('rejects injection through array elements and directive names', () => {
    expect(() =>
      validateSecurityHeadersOptions(csp({ 'default-src': ["'self'; script-src *"] })),
    ).toThrow(HttpConfigError);
    expect(() => validateSecurityHeadersOptions(csp({ 'script src': ["'self'"] }))).toThrow(
      HttpConfigError,
    );
    expect(() => validateSecurityHeadersOptions(csp({ 'img-src': ['a b'] }))).toThrow(
      HttpConfigError,
    );
    expect(() => validateSecurityHeadersOptions(csp({ 'img-src': 'a;b' }))).toThrow(
      HttpConfigError,
    );
    expect(() => validateSecurityHeadersOptions(csp({ 'img-src': ['a,b'] }))).toThrow(
      HttpConfigError,
    );
    expect(() => validateSecurityHeadersOptions(csp({ 'img-src': ['a\r\nX: y'] }))).toThrow(
      HttpConfigError,
    );
  });

  test('rejects undefined, null and other non-string directive values with HttpConfigError', () => {
    for (const bad of [undefined, null, 42, {}]) {
      expect(() =>
        validateSecurityHeadersOptions(csp({ 'img-src': bad as unknown as string })),
      ).toThrow(HttpConfigError);
    }
  });

  test('rejects non-string array elements with HttpConfigError', () => {
    expect(() =>
      validateSecurityHeadersOptions(csp({ 'img-src': ['self', 42] as unknown as string[] })),
    ).toThrow(HttpConfigError);
  });

  test('accepts normal configs', () => {
    expect(() => validateSecurityHeadersOptions({})).not.toThrow();
    expect(() => validateSecurityHeadersOptions({ contentSecurityPolicy: false })).not.toThrow();
    expect(() =>
      validateSecurityHeadersOptions(
        csp({ 'img-src': ["'self'", 'data:'], 'style-src': "'self' https:", sandbox: true }),
      ),
    ).not.toThrow();
  });

  test('nonce without script-src or default-src sources yields a nonce-only script-src', () => {
    expect(serializeCsp({ 'img-src': ["'self'"] }, 'abc')).toBe(
      "img-src 'self'; script-src 'nonce-abc'",
    );
    expect(serializeCsp({ 'default-src': true }, 'abc')).toBe(
      "default-src; script-src 'nonce-abc'",
    );
  });
});
