export type Algorithm = 'sliding-window' | 'token-bucket';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
  algorithm: Algorithm;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /** Epoch milliseconds when the limit resets (sliding) or the next token arrives (bucket). */
  resetAt: number;
}

/** Stores implement the algorithm themselves so it can run atomically (e.g. one Redis script). */
export interface RateLimitStore {
  consume(key: string, rule: RateLimitRule): Promise<ConsumeResult>;
  close?(): void | Promise<void>;
}
