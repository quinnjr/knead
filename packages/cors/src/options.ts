import { HpmwsError, InjectionToken } from '@hpmws/core';
import type { Ctx } from '@hpmws/http';

export type CorsOrigin =
  | string
  | readonly string[]
  | RegExp
  | ((origin: string, ctx: Ctx) => boolean | Promise<boolean>);

export interface CorsOptions {
  /**
   * `'*'`, an exact origin, a list, a RegExp, or a predicate. A RegExp must be anchored
   * (`^…$`, or it matches anywhere: `/app\.example/` accepts `https://app.example.evil`); an
   * unanchored one is a CorsConfigError. It must also be linear (no nested quantifiers such as
   * `(a+)+`, which backtrack catastrophically).
   */
  origin: CorsOrigin;
  /** Default: GET, HEAD, PUT, PATCH, POST, DELETE. */
  methods?: readonly string[];
  /** Default: reflect Access-Control-Request-Headers. */
  allowedHeaders?: readonly string[];
  exposedHeaders?: readonly string[];
  credentials?: boolean;
  /** Seconds browsers may cache a preflight. */
  maxAge?: number;
}

export const CORS_OPTIONS = new InjectionToken<CorsOptions>('CORS_OPTIONS');

export class CorsConfigError extends HpmwsError {}

/** Whether a RegExp source starts with `^` and ends with an unescaped `$`. */
function isAnchored(source: string): boolean {
  if (!source.startsWith('^') || !source.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

/** @throws CorsConfigError for invalid options, including an unanchored RegExp origin. */
export function validateCorsOptions(options: CorsOptions): void {
  if (Array.isArray(options.origin) && options.origin.includes('*')) {
    throw new CorsConfigError("Use origin: '*' instead of listing '*' among origins.");
  }
  if (options.origin === '*' && options.credentials) {
    throw new CorsConfigError(
      'CORS origin "*" cannot be combined with credentials: true; list the allowed origins explicitly.',
    );
  }
  if (options.origin instanceof RegExp && !isAnchored(options.origin.source)) {
    throw new CorsConfigError(
      `CORS origin RegExp ${String(options.origin)} must be anchored with ^ and $ ` +
        '(an unanchored pattern such as /app\\.example/ also matches https://app.example.evil); ' +
        'write it as /^...$/, grouping alternatives as /^(?:a|b)$/.',
    );
  }
  if (options.maxAge !== undefined && (!Number.isInteger(options.maxAge) || options.maxAge < 0)) {
    throw new CorsConfigError(`CORS maxAge must be a non-negative integer, got ${options.maxAge}`);
  }
}
