import { HpmwsError, InjectionToken } from '@hpmws/core';
import type { Ctx } from '@hpmws/http';

export type CorsOrigin =
  | string
  | readonly string[]
  | RegExp
  | ((origin: string, ctx: Ctx) => boolean | Promise<boolean>);

export interface CorsOptions {
  /** `'*'`, an exact origin, a list, a RegExp, or a predicate. */
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

export function validateCorsOptions(options: CorsOptions): void {
  const wildcard =
    options.origin === '*' || (Array.isArray(options.origin) && options.origin.includes('*'));
  if (wildcard && options.credentials) {
    throw new CorsConfigError(
      'CORS origin "*" cannot be combined with credentials: true; list the allowed origins explicitly.',
    );
  }
  if (options.maxAge !== undefined && (!Number.isInteger(options.maxAge) || options.maxAge < 0)) {
    throw new CorsConfigError(`CORS maxAge must be a non-negative integer, got ${options.maxAge}`);
  }
}
