import { type Ctx, createRouteDecorator } from '@hpmws/http';
import type { Duration } from './duration.js';

export type KeyFn = (ctx: Ctx) => string | undefined | Promise<string | undefined>;

export interface RateLimitRouteOptions {
  limit?: number;
  window?: Duration;
  key?: KeyFn;
}

export const RATE_LIMIT_META = Symbol('hpmws:rate-limit');
export const SKIP_RATE_LIMIT_META = Symbol('hpmws:skip-rate-limit');

const rateLimitMeta = createRouteDecorator<RateLimitRouteOptions>(RATE_LIMIT_META);
const skipMeta = createRouteDecorator<boolean>(SKIP_RATE_LIMIT_META);

/** Per-route (or per-controller) limit with its own counter. */
export function RateLimit(options: RateLimitRouteOptions) {
  return rateLimitMeta(options);
}

export function SkipRateLimit() {
  return skipMeta(true);
}
