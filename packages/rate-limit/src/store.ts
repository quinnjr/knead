import type { Logger } from '@knead-js/http';

export type Algorithm = 'sliding-window' | 'token-bucket';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
  algorithm: Algorithm;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /**
   * Epoch milliseconds. On denial, the earliest time a request would be admitted. On success, when
   * the quota is fully restored (sliding window: window end; token bucket: bucket full).
   */
  resetAt: number;
}

/** Stores implement the algorithm themselves so it can run atomically (e.g. one Redis script). */
export interface RateLimitStore {
  consume(key: string, rule: RateLimitRule): Promise<ConsumeResult>;
  close?(): void | Promise<void>;
  /**
   * Receives the application's LOGGER when RateLimitModule starts, for a store built outside
   * dependency injection. Optional.
   */
  setLogger?(logger: Logger): void;
}
