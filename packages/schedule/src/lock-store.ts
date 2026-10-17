import { ScheduleConfigError } from './errors.js';

/**
 * Claims a cron firing so it runs on one instance only. The scheduler calls `acquire` with
 * `<job name>:<scheduled time in epoch ms>`; every instance computes the same key for a firing.
 * Locks are never released: they expire after `ttlMs`, the window in which the firing cannot run
 * again, so a late instance cannot repeat it.
 */
export interface ScheduleLockStore {
  /** True for exactly one caller per key until `ttlMs` has passed. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  close?(): void | Promise<void>;
}

export function assertLockTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new ScheduleConfigError(`Lock TTL must be an integer >= 1 (ms), got ${String(ttlMs)}.`);
  }
}

const SWEEP_EVERY = 256;

/** Locks held in this process: deduplicates between schedulers in one process only. */
export class MemoryLockStore implements ScheduleLockStore {
  readonly #locks = new Map<string, number>();
  #acquires = 0;

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    assertLockTtl(ttlMs);
    const now = Date.now();
    if (++this.#acquires % SWEEP_EVERY === 0) {
      for (const [k, expiresAt] of this.#locks) if (expiresAt <= now) this.#locks.delete(k);
    }
    const expiresAt = this.#locks.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.#locks.set(key, now + ttlMs);
    return true;
  }

  /** @internal Number of stored locks, expired or not. */
  get size(): number {
    return this.#locks.size;
  }
}
