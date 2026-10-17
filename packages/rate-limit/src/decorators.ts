import { type Ctx, createRouteDecorator } from '@knead-js/http';
import { type Duration, parseDuration } from './duration.js';

export type KeyFn = (ctx: Ctx) => string | undefined | Promise<string | undefined>;

export interface RateLimitRouteOptions {
  limit?: number;
  window?: Duration;
  key?: KeyFn;
}

export const RATE_LIMIT_META = Symbol('knead:rate-limit');
export const SKIP_RATE_LIMIT_META = Symbol('knead:skip-rate-limit');

/** What is stored in route metadata: the validated options plus the parsed window. */
export interface RateLimitRouteMeta extends RateLimitRouteOptions {
  windowMs?: number;
}

const rateLimitMeta = createRouteDecorator<RateLimitRouteMeta>(RATE_LIMIT_META);
const skipMeta = createRouteDecorator<boolean>(SKIP_RATE_LIMIT_META);

/**
 * Per-route (or per-controller) limit with its own counter.
 * @throws RangeError for a limit that is not a positive integer, an invalid window or a `key`
 * that is not a function.
 */
export function RateLimit(options: RateLimitRouteOptions) {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new RangeError(`Rate limit must be a positive integer, got ${String(options.limit)}.`);
  }
  if (options.key !== undefined && typeof options.key !== 'function') {
    throw new RangeError(`key must be a function, got ${typeOf(options.key)}.`);
  }
  const windowMs = options.window !== undefined ? parseDuration(options.window) : undefined;
  return rateLimitMeta(windowMs === undefined ? options : { ...options, windowMs });
}

export function SkipRateLimit() {
  return skipMeta(true);
}

/** @internal `typeof`, with null told apart. */
export function typeOf(value: unknown): string {
  return value === null ? 'null' : typeof value;
}
