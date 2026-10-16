import { InjectionToken, inject, type OnModuleDestroy } from '@hpmws/core';
import {
  type Ctx,
  ForbiddenException,
  isIpv6Prefix,
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
  type RateLimitRouteMeta,
  SKIP_RATE_LIMIT_META,
} from './decorators.js';
import { type Duration, parseDuration } from './duration.js';
import { maskIp } from './keys.js';
import type { Algorithm, ConsumeResult, RateLimitStore } from './store.js';

export interface RateLimitModuleOptions {
  limit: number;
  window: Duration;
  algorithm?: Algorithm;
  /** Default: a MemoryStore (single-process only). */
  store?: RateLimitStore;
  /** Default: the client IP (`ctx.ip`), with IPv6 masked to `ipv6Subnet`. */
  key?: KeyFn;
  /**
   * Prefix length IPv6 client addresses are masked to by the default key, since one client
   * usually controls a whole /64. Integer 1–128; 128 keys each address. Default 64.
   */
  ipv6Subnet?: number;
  /**
   * When the key function returns no key: `'shared'` counts the request against one anonymous
   * bucket per scope, `'skip'` lets it through unlimited, `'deny'` rejects it with 403.
   * Default 'shared'. The first keyless request logs a warning.
   */
  onMissingKey?: 'skip' | 'shared' | 'deny';
  /**
   * What to do when the store throws. Default 'allow' (fail open, logged). Use 'deny' (503) when
   * the limit protects authentication, where failing open would allow brute forcing.
   */
  onStoreError?: 'allow' | 'deny';
}

const MISSING_KEY_MODES = new Set(['skip', 'shared', 'deny']);

/** @throws RangeError for invalid module options. */
export function validateRateLimitOptions(options: RateLimitModuleOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError(`Rate limit must be a positive integer, got ${options.limit}`);
  }
  parseDuration(options.window);
  const subnet = options.ipv6Subnet;
  if (subnet !== undefined && !isIpv6Prefix(subnet)) {
    throw new RangeError(`ipv6Subnet must be an integer from 0 to 128, got ${String(subnet)}.`);
  }
  if (options.onMissingKey !== undefined && !MISSING_KEY_MODES.has(options.onMissingKey)) {
    throw new RangeError(
      `onMissingKey must be 'skip', 'shared' or 'deny', got ${String(options.onMissingKey)}.`,
    );
  }
}

export const RATE_LIMIT_OPTIONS = new InjectionToken<RateLimitModuleOptions>('RATE_LIMIT_OPTIONS');
export const RATE_LIMIT_STORE = new InjectionToken<RateLimitStore>('RATE_LIMIT_STORE');

export class RateLimitMiddleware implements Middleware, OnModuleDestroy {
  readonly #options = inject(RATE_LIMIT_OPTIONS);
  readonly #store = inject(RATE_LIMIT_STORE);
  readonly #logger = inject(LOGGER);
  readonly #windowMs = parseDuration(this.#options.window);
  readonly #ipv6Subnet = this.#options.ipv6Subnet ?? 64;
  readonly #defaultKey: KeyFn = (ctx) =>
    ctx.ip === undefined ? undefined : maskIp(ctx.ip, this.#ipv6Subnet);
  #warnedNoKey = false;

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const meta = ctx.route?.meta;
    if (meta?.[SKIP_RATE_LIMIT_META]) return next();
    const override = meta?.[RATE_LIMIT_META] as RateLimitRouteMeta | undefined;
    const limit = override?.limit ?? this.#options.limit;
    const windowMs = override?.windowMs ?? this.#windowMs;
    const keyFn: KeyFn = override?.key ?? this.#options.key ?? this.#defaultKey;
    const key = await keyFn(ctx);
    const scope = override && ctx.route ? `${ctx.route.method} ${ctx.route.path}` : 'global';
    let storeKey = `${scope}|${key}`;
    if (!key) {
      const mode = this.#options.onMissingKey ?? 'shared';
      if (!this.#warnedNoKey) {
        this.#warnedNoKey = true;
        this.#logger.warn(
          `The rate limit key function returned no key; onMissingKey is '${mode}'.`,
        );
      }
      if (mode === 'skip') return next();
      if (mode === 'deny') throw new ForbiddenException('Rate limiting requires a client key');
      // A different separator than `${scope}|${key}`, so it never collides with a real key.
      storeKey = `${scope}#anonymous`;
    }
    let result: ConsumeResult;
    try {
      result = await this.#store.consume(storeKey, {
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
