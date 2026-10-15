import type { ConsumeResult, RateLimitRule, RateLimitStore } from './store.js';

export interface MemoryStoreOptions {
  now?: () => number;
  /**
   * Upper bound on tracked keys (integer >= 1); least recently used keys are evicted. Default 10 000.
   * Eviction resets the evicted key's counter, so a flood of distinct keys can reset other clients'
   * limits: size this for your key cardinality, or use the RedisStore.
   */
  maxKeys?: number;
  /** Expired-entry sweep interval; 0 disables the timer. Default 60 000. */
  sweepIntervalMs?: number;
}

interface SlidingState {
  kind: 'sliding';
  windowMs: number;
  start: number;
  current: number;
  previous: number;
}

interface BucketState {
  kind: 'bucket';
  windowMs: number;
  tokens: number;
  updatedAt: number;
}

export class MemoryStore implements RateLimitStore {
  readonly #entries = new Map<string, SlidingState | BucketState>();
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    const maxKeys = options.maxKeys ?? 10_000;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError(`maxKeys must be an integer >= 1, got ${String(maxKeys)}.`);
    }
    this.#maxKeys = maxKeys;
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.#timer = setInterval(() => this.sweep(), interval);
      this.#timer.unref?.();
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  async consume(key: string, rule: RateLimitRule): Promise<ConsumeResult> {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      throw new RangeError(`Rate limit must be a positive integer, got ${String(rule.limit)}.`);
    }
    if (!Number.isInteger(rule.windowMs) || rule.windowMs <= 0) {
      throw new RangeError(
        `Rate limit window must be a positive integer (ms), got ${String(rule.windowMs)}.`,
      );
    }
    return rule.algorithm === 'token-bucket' ? this.#bucket(key, rule) : this.#sliding(key, rule);
  }

  sweep(): void {
    const now = this.#now();
    for (const [key, s] of this.#entries) {
      const expired =
        s.kind === 'sliding' ? now >= s.start + 2 * s.windowMs : now - s.updatedAt >= s.windowMs;
      if (expired) this.#entries.delete(key);
    }
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  #touch(key: string, state: SlidingState | BucketState): void {
    this.#entries.delete(key);
    this.#entries.set(key, state);
    while (this.#entries.size > this.#maxKeys) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }

  #sliding(key: string, { limit, windowMs }: RateLimitRule): ConsumeResult {
    const now = this.#now();
    const prev = this.#entries.get(key);
    const sameRule = prev?.kind === 'sliding' && prev.windowMs === windowMs ? prev : undefined;
    let start = Math.floor(now / windowMs) * windowMs;
    let s: SlidingState;
    if (!sameRule) {
      s = { kind: 'sliding', windowMs, start, current: 0, previous: 0 };
    } else if (sameRule.start >= start) {
      // Same window, or the clock stepped backwards: keep treating the stored window as current.
      s = sameRule;
      start = sameRule.start;
    } else {
      s = {
        ...sameRule,
        start,
        previous: sameRule.start === start - windowMs ? sameRule.current : 0,
        current: 0,
      };
    }
    const weight = Math.min(1, Math.max(0, (windowMs - (now - start)) / windowMs));
    const windowEnd = start + windowMs;
    if (s.previous * weight + s.current + 1 > limit) {
      this.#touch(key, s);
      return { allowed: false, remaining: 0, resetAt: this.#slidingRetryAt(s, limit, now) };
    }
    s.current += 1;
    this.#touch(key, s);
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - (s.previous * weight + s.current))),
      resetAt: windowEnd,
    };
  }

  /** Earliest time a denied sliding-window request would be admitted. */
  #slidingRetryAt(s: SlidingState, limit: number, now: number): number {
    const { start, windowMs: w, previous, current } = s;
    const windowEnd = start + w;
    if (previous > 0 && current + 1 <= limit) {
      // previous * (w - (t - start)) / w + current + 1 <= limit, solved for t.
      const t = Math.ceil(start + w - ((limit - current - 1) * w) / previous);
      if (t < windowEnd) return Math.max(now, t);
    }
    // Next window: previous' = current, current' = 0.
    if (current <= limit - 1) return windowEnd;
    return Math.max(windowEnd, Math.ceil(windowEnd + w - ((limit - 1) * w) / current));
  }

  #bucket(key: string, { limit, windowMs }: RateLimitRule): ConsumeResult {
    const now = this.#now();
    const prev = this.#entries.get(key);
    const sameRule = prev?.kind === 'bucket' && prev.windowMs === windowMs ? prev : undefined;
    // A clock that steps backwards must neither mint tokens nor drive them negative.
    let tokens = sameRule
      ? Math.min(
          limit,
          sameRule.tokens + (Math.max(0, now - sameRule.updatedAt) * limit) / windowMs,
        )
      : limit;
    let allowed = false;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = true;
    }
    const updatedAt = sameRule ? Math.max(now, sameRule.updatedAt) : now;
    this.#touch(key, { kind: 'bucket', windowMs, tokens, updatedAt });
    // Allowed: time until the bucket is full. Denied: time until the next whole token.
    const missing = allowed ? limit - tokens : 1 - tokens;
    return {
      allowed,
      remaining: Math.floor(tokens),
      resetAt: updatedAt + Math.ceil((missing * windowMs) / limit),
    };
  }
}
