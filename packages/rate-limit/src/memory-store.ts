import type { ConsumeResult, RateLimitRule, RateLimitStore } from './store.js';

export interface MemoryStoreOptions {
  now?: () => number;
  /** Upper bound on tracked keys; least recently used keys are evicted. Default 10 000. */
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
    this.#maxKeys = options.maxKeys ?? 10_000;
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
    const start = Math.floor(now / windowMs) * windowMs;
    const prev = this.#entries.get(key);
    let s: SlidingState;
    if (prev?.kind !== 'sliding' || prev.windowMs !== windowMs) {
      s = { kind: 'sliding', windowMs, start, current: 0, previous: 0 };
    } else if (prev.start !== start) {
      s = {
        ...prev,
        start,
        previous: prev.start === start - windowMs ? prev.current : 0,
        current: 0,
      };
    } else {
      s = prev;
    }
    const weight = (windowMs - (now - start)) / windowMs;
    const estimate = s.previous * weight + s.current;
    const resetAt = start + windowMs;
    if (estimate + 1 > limit) {
      this.#touch(key, s);
      return { allowed: false, remaining: 0, resetAt };
    }
    s.current += 1;
    this.#touch(key, s);
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - (s.previous * weight + s.current))),
      resetAt,
    };
  }

  #bucket(key: string, { limit, windowMs }: RateLimitRule): ConsumeResult {
    const now = this.#now();
    const rate = limit / windowMs;
    const prev = this.#entries.get(key);
    let tokens =
      prev?.kind === 'bucket' && prev.windowMs === windowMs
        ? Math.min(limit, prev.tokens + (now - prev.updatedAt) * rate)
        : limit;
    let allowed = false;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = true;
    }
    this.#touch(key, { kind: 'bucket', windowMs, tokens, updatedAt: now });
    const resetAt = now + Math.ceil((allowed ? limit - tokens : 1 - tokens) / rate);
    return { allowed, remaining: Math.floor(tokens), resetAt };
  }
}
