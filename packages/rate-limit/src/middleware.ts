import { InjectionToken, inject, type OnModuleDestroy } from '@knead/core';
import {
  type Ctx,
  ForbiddenException,
  type Guard,
  HTTP_DEVELOPMENT,
  isIpv6Prefix,
  LOGGER,
  logError,
  type Middleware,
  type Next,
  ServiceUnavailableException,
  TooManyRequestsException,
  withHeaders,
} from '@knead/http';
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
  /**
   * Install the global RateLimitMiddleware. Default true. Set false when the limit is applied
   * only through RateLimitGuard (for example to key on `ctx.state.user`).
   */
  middleware?: boolean;
}

const MISSING_KEY_MODES = new Set(['skip', 'shared', 'deny']);

/** @throws RangeError for invalid module options. */
export function validateRateLimitOptions(options: RateLimitModuleOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError(`Rate limit must be a positive integer, got ${options.limit}`);
  }
  parseDuration(options.window);
  const subnet = options.ipv6Subnet;
  // 0 would put every IPv6 client into one bucket, so it is not accepted.
  if (subnet !== undefined && (!isIpv6Prefix(subnet) || subnet < 1)) {
    throw new RangeError(`ipv6Subnet must be an integer from 1 to 128, got ${String(subnet)}.`);
  }
  if (options.onMissingKey !== undefined && !MISSING_KEY_MODES.has(options.onMissingKey)) {
    throw new RangeError(
      `onMissingKey must be 'skip', 'shared' or 'deny', got ${String(options.onMissingKey)}.`,
    );
  }
}

export const RATE_LIMIT_OPTIONS = new InjectionToken<RateLimitModuleOptions>('RATE_LIMIT_OPTIONS');
export const RATE_LIMIT_STORE = new InjectionToken<RateLimitStore>('RATE_LIMIT_STORE');

/**
 * The request Ctx, resolver metadata and field name of a GraphQL ResolverCtx (which has
 * `http`, `meta` and `info`), or undefined for an HTTP Ctx.
 */
function resolverParts(
  ctx: Ctx,
): { http: Ctx; meta: Readonly<Record<PropertyKey, unknown>>; field: string } | undefined {
  const candidate = ctx as unknown as {
    http?: Ctx;
    meta?: Readonly<Record<PropertyKey, unknown>>;
    info?: { parentType?: { name?: string }; fieldName?: string };
  };
  if (!candidate.http || candidate.http === ctx) return undefined;
  const info = candidate.info;
  return {
    http: candidate.http,
    meta: candidate.meta ?? {},
    field: `${info?.parentType?.name ?? '?'}.${info?.fieldName ?? '?'}`,
  };
}

/**
 * The limit check shared by RateLimitMiddleware and RateLimitGuard. Returns the RateLimit-*
 * headers to send, `undefined` when the request is not limited, or throws 429 (or 403/503).
 */
export class RateLimiter implements OnModuleDestroy {
  readonly #options = inject(RATE_LIMIT_OPTIONS);
  readonly #store = inject(RATE_LIMIT_STORE);
  readonly #logger = inject(LOGGER);
  readonly #development = inject(HTTP_DEVELOPMENT, { optional: true }) ?? false;
  readonly #windowMs = parseDuration(this.#options.window);
  readonly #ipv6Subnet = this.#options.ipv6Subnet ?? 64;
  readonly #defaultKey: KeyFn = (ctx) =>
    ctx.ip === undefined ? undefined : maskIp(ctx.ip, this.#ipv6Subnet);
  #warnedNoKey = false;

  /** `phase` separates the guard's counters from the middleware's. */
  async check(
    ctx: Ctx,
    phase: 'middleware' | 'guard',
  ): Promise<Record<string, string> | undefined> {
    // On a GraphQL ResolverCtx the request is `ctx.http`, and the metadata is the resolver's.
    const resolver = resolverParts(ctx);
    const meta = resolver ? resolver.meta : ctx.route?.meta;
    if (meta?.[SKIP_RATE_LIMIT_META]) return undefined;
    const override = meta?.[RATE_LIMIT_META] as RateLimitRouteMeta | undefined;
    const limit = override?.limit ?? this.#options.limit;
    const windowMs = override?.windowMs ?? this.#windowMs;
    const keyFn: KeyFn = override?.key ?? this.#options.key ?? this.#defaultKey;
    const key = await (keyFn === this.#defaultKey && resolver ? keyFn(resolver.http) : keyFn(ctx));
    const route = !override
      ? 'global'
      : resolver
        ? `graphql ${resolver.field}`
        : ctx.route
          ? `${ctx.route.method} ${ctx.route.path}`
          : 'global';
    const scope = phase === 'guard' ? `guard:${route}` : route;
    let storeKey = `${scope}|${key}`;
    if (!key) {
      const mode = this.#options.onMissingKey ?? 'shared';
      if (!this.#warnedNoKey) {
        this.#warnedNoKey = true;
        this.#logger.warn(
          `The rate limit key function returned no key; onMissingKey is '${mode}'.`,
        );
      }
      if (mode === 'skip') return undefined;
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
      logError(
        { logger: this.#logger, development: this.#development },
        'Rate limit store failed',
        error,
        'warn',
      );
      if (this.#options.onStoreError === 'deny')
        throw new ServiceUnavailableException('Rate limiting is unavailable');
      return undefined;
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
    return headers;
  }

  async onModuleDestroy(): Promise<void> {
    await this.#store.close?.();
  }
}

/**
 * Global middleware (priority 900): it runs before guards, so its key function sees the
 * request but not what guards set (`ctx.state.user`). Use RateLimitGuard for that.
 */
export class RateLimitMiddleware implements Middleware {
  readonly #limiter = inject(RateLimiter);

  async use(ctx: Ctx, next: Next): Promise<Response> {
    const headers = await this.#limiter.check(ctx, 'middleware');
    if (!headers) return next();
    return withHeaders(await next(), headers);
  }
}

/**
 * The same limit (module options and `@RateLimit()` overrides) applied in the guard phase:
 * `@UseGuards(AuthGuard, RateLimitGuard)` or `APP_GUARD`. Guards run in order, so its key
 * function can read `ctx.state.user` set by an earlier guard, for per-user limits. Its counters
 * are separate from RateLimitMiddleware's; set `middleware: false` in forRoot() to use only
 * the guard.
 */
export class RateLimitGuard implements Guard {
  readonly #limiter = inject(RateLimiter);

  async canActivate(ctx: Ctx): Promise<boolean> {
    const headers = await this.#limiter.check(ctx, 'guard');
    // On a ResolverCtx the headers go on the GraphQL HTTP response (`ctx.http.res`).
    const target = resolverParts(ctx)?.http ?? ctx;
    for (const [name, value] of Object.entries(headers ?? {})) target.res?.headers.set(name, value);
    return true;
  }
}
