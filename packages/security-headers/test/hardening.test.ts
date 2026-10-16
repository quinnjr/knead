import { describe, expect, test } from 'bun:test';
import { HttpConfigError } from '@hpmws/http';
import {
  buildHeaders,
  DEFAULT_OPTIONS,
  mergeOptions,
  SecurityHeaders,
  SecurityHeadersModule,
  validateSecurityHeadersOptions,
} from '../src/index.js';

const headers = (options = DEFAULT_OPTIONS, secure = false) =>
  Object.fromEntries(buildHeaders(options, { secure }));

describe('HSTS validation', () => {
  const hsts = (strictTransportSecurity: object) => () =>
    validateSecurityHeadersOptions({ strictTransportSecurity });

  test('maxAge must be a non-negative integer', () => {
    for (const maxAge of [-1, 1.5, Number.NaN, '600']) {
      expect(hsts({ maxAge })).toThrow(HttpConfigError);
    }
    expect(hsts({ maxAge: 0 })).not.toThrow();
  });

  test('preload requires includeSubDomains and a maxAge of at least one year', () => {
    expect(hsts({ preload: true, includeSubDomains: false })).toThrow(HttpConfigError);
    expect(hsts({ preload: true, maxAge: 86_400 })).toThrow(HttpConfigError);
    expect(hsts({ preload: true })).not.toThrow();
    expect(hsts({ preload: true, maxAge: 63_072_000, includeSubDomains: true })).not.toThrow();
  });

  test('forRoot and @SecurityHeaders() reject invalid HSTS', () => {
    const bad = { strictTransportSecurity: { maxAge: 600, preload: true } };
    expect(() => SecurityHeadersModule.forRoot(bad)).toThrow(HttpConfigError);
    expect(() => SecurityHeaders(bad)).toThrow(HttpConfigError);
  });
});

describe('new default headers', () => {
  test('Permissions-Policy and X-Permitted-Cross-Domain-Policies are sent by default', () => {
    const h = headers();
    expect(h['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    );
    expect(h['x-permitted-cross-domain-policies']).toBe('none');
  });

  test('both can be overridden or disabled', () => {
    const custom = headers(
      mergeOptions(DEFAULT_OPTIONS, {
        permissionsPolicy: 'camera=(self)',
        xPermittedCrossDomainPolicies: 'master-only',
      }),
    );
    expect(custom['permissions-policy']).toBe('camera=(self)');
    expect(custom['x-permitted-cross-domain-policies']).toBe('master-only');
    const off = headers(
      mergeOptions(DEFAULT_OPTIONS, {
        permissionsPolicy: false,
        xPermittedCrossDomainPolicies: false,
      }),
    );
    expect(off['permissions-policy']).toBeUndefined();
    expect(off['x-permitted-cross-domain-policies']).toBeUndefined();
  });

  test('a Permissions-Policy with line breaks is a configuration error', () => {
    expect(() =>
      validateSecurityHeadersOptions({ permissionsPolicy: 'camera=()\r\nX-Injected: 1' }),
    ).toThrow(HttpConfigError);
  });
});
