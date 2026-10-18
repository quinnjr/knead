import { Injectable, InjectionToken, inject, type OnModuleDestroy } from '@knead-js/core';
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
} from '@knead-js/http';
import {
  type KeyFn,
  RATE_LIMIT_META,
  type RateLimitRouteMeta,
  SKIP_RATE_LIMIT_META,
  typeOf,
} from './decorators.js';
import { type Duration, parseDuration } from './duration.js';
import { maskIp } from './keys.js';
import type { Algorithm, ConsumeResult, RateLimitRule, RateLimitStore } from './store.js';

/** During a store outage, at most one failure line per this interval. */
const STORE_ERROR_LOG_INTERVAL_MS = 10_000;

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
const STORE_ERROR_MODES = new Set(['allow', 'deny']);
const ALGORITHMS = new Set(['sliding-window', 'token-bucket']);

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
  // Anything but 'deny' fails open, so a typo here would silently weaken the limit.
  if (options.onStoreError !== undefined && !STORE_ERROR_MODES.has(options.onStoreError)) {
    throw new RangeError(
      `onStoreError must be 'allow' or 'deny', got ${String(options.onStoreError)}.`,
    );
  }
  if (options.algorithm !== undefined && !ALGORITHMS.has(options.algorithm)) {
    throw new RangeError(
      `algorithm must be 'sliding-window' or 'token-bucket', got ${String(options.algorithm)}.`,
    );
  }
  // A store without consume() would throw on every request, and the default onStoreError
  // ('allow') would then let every request through.
  if (options.store !== undefined && typeof options.store?.consume !== 'function') {
    throw new RangeError('store must implement consume(key, rule).');
  }
  if (options.key !== undefined && typeof options.key !== 'function') {
    throw new RangeError(`key must be a function, got ${typeOf(options.key)}.`);
  }
  if (options.middleware !== undefined && typeof options.middleware !== 'boolean') {
    throw new RangeError(`middleware must be a boolean, got ${typeOf(options.middleware)}.`);
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
@Injectable()
export class RateLimiter implements OnModuleDestroy {
  readonly #options = inject(RATE_LIMIT_OPTIONS);
  readonly #store = inject(RATE_LIMIT_STORE);
  readonly #logger = inject(LOGGER);
  readonly #development = inject(HTTP_DEVELOPMENT);
  readonly #windowMs = parseDuration(this.#options.window);
  readonly #ipv6Subnet = this.#options.ipv6Subnet ?? 64;
  readonly #defaultKey: KeyFn = (ctx) =>
    ctx.ip === undefined ? undefined : maskIp(ctx.ip, this.#ipv6Subnet);
  #warnedNoKey = false;
  /**
   * Store calls of one HTTP request, by store key, for checks without a `@RateLimit()` override:
   * the guard on a nested GraphQL field runs once per resolved item, and with an HTTP-level guard
   * as well, but the request counts once per scope.
   */
  readonly #perRequest = new WeakMap<Request, Map<string, Promise<ConsumeResult | undefined>>>();
  /** Store failures since the outage began; 0 while the store works. */
  #failures = 0;
  /** Failures not logged since the last line, and when that line was logged. */
  #unlogged = 0;
  #loggedAt = 0;

  constructor() {
    // A store built outside DI (RedisStore) logs through the application's LOGGER from now on.
    this.#store.setLogger?.(this.#logger);
  }

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
    const rule: RateLimitRule = {
      limit,
      windowMs,
      algorithm: this.#options.algorithm ?? 'sliding-window',
    };
    const req = (resolver?.http ?? ctx).req;
    let result: ConsumeResult | undefined;
    if (!override && req) {
      let calls = this.#perRequest.get(req);
      if (!calls) {
        calls = new Map();
        this.#perRequest.set(req, calls);
      }
      let call = calls.get(storeKey);
      if (!call) {
        call = this.#consume(storeKey, rule);
        calls.set(storeKey, call);
      }
      result = await call;
    } else {
      result = await this.#consume(storeKey, rule);
    }
    // The store failed and onStoreError is 'allow'.
    if (!result) return undefined;
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

  /** The store's answer, or undefined when it failed and onStoreError allows the request. */
  async #consume(storeKey: string, rule: RateLimitRule): Promise<ConsumeResult | undefined> {
    let result: ConsumeResult;
    try {
      result = await this.#store.consume(storeKey, rule);
    } catch (error) {
      this.#logStoreError(error);
      if (this.#options.onStoreError === 'deny')
        throw new ServiceUnavailableException('Rate limiting is unavailable');
      return undefined;
    }
    if (this.#failures > 0) {
      this.#logger.warn(`Rate limit store recovered after ${this.#failures} failures.`);
      this.#failures = 0;
    }
    return result;
  }

  /**
   * An outage fails every request: the first failure is logged, then at most one line every
   * STORE_ERROR_LOG_INTERVAL_MS with the count of failures not logged.
   */
  #logStoreError(error: unknown): void {
    const now = Date.now();
    const first = this.#failures++ === 0;
    if (!first && now - this.#loggedAt < STORE_ERROR_LOG_INTERVAL_MS) {
      this.#unlogged++;
      return;
    }
    const message = first
      ? 'Rate limit store failed'
      : `Rate limit store still failing (${this.#unlogged} failures not logged)`;
    logError({ logger: this.#logger, development: this.#development }, message, error, 'warn');
    this.#unlogged = 0;
    this.#loggedAt = now;
  }

  async onModuleDestroy(): Promise<void> {
    await this.#store.close?.();
  }
}

/**
 * Global middleware (priority 900): it runs before guards, so its key function sees the
 * request but not what guards set (`ctx.state.user`). Use RateLimitGuard for that.
 */
@Injectable()
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
@Injectable()
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
