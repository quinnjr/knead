import { InjectionToken, inject, type OnModuleDestroy } from '@hpmws/core';
import {
  type Ctx,
  LOGGER,
  type Middleware,
  type Next,
  ServiceUnavailableException,
  TooManyRequestsException,
  withHeaders,
} from '@hpmws/http';
import {
  type KeyFn,
  RATE_LIMIT_META,
  type RateLimitRouteOptions,
  SKIP_RATE_LIMIT_META,
} from './decorators.js';
import { type Duration, parseDuration } from './duration.js';
import type { Algorithm, ConsumeResult, RateLimitStore } from './store.js';

export interface RateLimitModuleOptions {
  limit: number;
  window: Duration;
  algorithm?: Algorithm;
  /** Default: a MemoryStore (single-process only). */
  store?: RateLimitStore;
  /** Default: the client IP. */
  key?: KeyFn;
  /** What to do when the store throws. Default 'allow' (fail open, logged). */
  onStoreError?: 'allow' | 'deny';
}

export const RATE_LIMIT_OPTIONS = new InjectionToken<RateLimitModuleOptions>('RATE_LIMIT_OPTIONS');
export const RATE_LIMIT_STORE = new InjectionToken<RateLimitStore>('RATE_LIMIT_STORE');

export class RateLimitMiddleware implements Middleware, OnModuleDestroy {
  readonly #options = inject(RATE_LIMIT_OPTIONS);
  readonly #store = inject(RATE_LIMIT_STORE);
  readonly #logger = inject(LOGGER);
  readonly #windowMs = parseDuration(this.#options.window);
  #warnedNoKey = false;

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const meta = ctx.route?.meta;
    if (meta?.[SKIP_RATE_LIMIT_META]) return next();
    const override = meta?.[RATE_LIMIT_META] as RateLimitRouteOptions | undefined;
    const limit = override?.limit ?? this.#options.limit;
    const windowMs =
      override?.window !== undefined ? parseDuration(override.window) : this.#windowMs;
    const keyFn: KeyFn = override?.key ?? this.#options.key ?? ((c) => c.ip);
    const key = await keyFn(ctx);
    if (!key) {
      if (!this.#warnedNoKey) {
        this.#warnedNoKey = true;
        this.#logger.warn('Rate limiting skipped: the key function returned no key.');
      }
      return next();
    }
    const scope = override && ctx.route ? `${ctx.route.method} ${ctx.route.path}` : 'global';
    let result: ConsumeResult;
    try {
      result = await this.#store.consume(`${scope}|${key}`, {
        limit,
        windowMs,
        algorithm: this.#options.algorithm ?? 'sliding-window',
      });
    } catch (error) {
      this.#logger.warn('Rate limit store failed', error);
      if (this.#options.onStoreError === 'deny')
        throw new ServiceUnavailableException('Rate limiting is unavailable');
      return next();
    }
    const resetSeconds = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
    const headers = {
      'ratelimit-limit': String(limit),
      'ratelimit-remaining': String(result.remaining),
      'ratelimit-reset': String(resetSeconds),
    };
    if (!result.allowed) {
      throw new TooManyRequestsException('Rate limit exceeded', {
        headers: { ...headers, 'retry-after': String(Math.max(1, resetSeconds)) },
      });
    }
    return withHeaders(await next(), headers);
  }

  async onModuleDestroy(): Promise<void> {
    await this.#store.close?.();
  }
}
