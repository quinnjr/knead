import { defaultRedisUrl, plaintextRedisHost } from '@knead-js/core';
import { RedisClient } from 'bun';
import { ScheduleConfigError } from './errors.js';
import { assertLockTtl, type ScheduleLockStore } from './lock-store.js';

export interface RedisLockStoreOptions {
  /**
   * An existing client (not closed by close()). A supplied client bypasses the plaintext
   * (`requireTls`) check: configure TLS on it yourself. Pass `client` or `url`, not both.
   */
  client?: RedisClient;
  /** Connection URL when no client is given (default: Bun's REDIS_URL / localhost). */
  url?: string;
  /** Key prefix. Default 'knead:schedule:'. */
  prefix?: string;
  /**
   * Throw at construction when `url` (or REDIS_URL/VALKEY_URL) is a plaintext `redis://` or
   * `valkey://` URL to a non-loopback host. Without it, that only logs a warning. Default false.
   */
  requireTls?: boolean;
  /** Where warnings go. Default: console. */
  logger?: { warn(message: string): void };
  /**
   * Milliseconds an acquire() waits for Redis before failing; the firing is then skipped and the
   * error reported to onError. Default 250. If Redis applied the SET anyway, every instance skips
   * that firing. A supplied client should set `enableOfflineQueue: false` so a timed-out command is
   * not sent later.
   */
  commandTimeout?: number;
}

/**
 * Cron locks shared by every instance using the same Redis: one `SET key 1 NX PX ttl` per firing.
 * Keys expire on their own and are never deleted, so a late instance cannot repeat a firing.
 */
export class RedisLockStore implements ScheduleLockStore {
  readonly #client: RedisClient;
  readonly #owned: boolean;
  readonly #prefix: string;
  readonly #commandTimeout: number;

  constructor(options: RedisLockStoreOptions = {}) {
    const timeout = options.commandTimeout ?? 250;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new ScheduleConfigError(
        `commandTimeout must be an integer >= 1 (ms), got ${String(timeout)}.`,
      );
    }
    this.#commandTimeout = timeout;
    if (options.client !== undefined && options.url !== undefined) {
      throw new ScheduleConfigError('Pass either client or url to RedisLockStore, not both.');
    }
    const remote = plaintextRedisHost(
      options.client === undefined ? (options.url ?? defaultRedisUrl()) : undefined,
    );
    if (remote !== undefined) {
      const problem =
        `RedisLockStore connects to ${remote} over plaintext redis://, so credentials cross the ` +
        'network unencrypted. Use rediss:// (TLS) with an ACL user.';
      if (options.requireTls) throw new ScheduleConfigError(problem);
      (options.logger ?? console).warn(`[knead:schedule] ${problem}`);
    }
    this.#owned = options.client === undefined;
    // Without the offline queue a timed-out SET is never sent later, after the firing was
    // reported as skipped.
    this.#client = options.client ?? new RedisClient(options.url, { enableOfflineQueue: false });
    this.#prefix = options.prefix ?? 'knead:schedule:';
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    assertLockTtl(ttlMs);
    const args = [`${this.#prefix}${key}`, '1', 'NX', 'PX', String(ttlMs)];
    let expired = false;
    const reply = await withTimeout(
      (async () => {
        if (!this.#client.connected) await this.#client.connect();
        // A SET sent after the timeout could claim a firing that was already reported skipped.
        if (expired) return null;
        return this.#client.send('SET', args);
      })(),
      this.#commandTimeout,
    ).finally(() => {
      expired = true;
    });
    return reply === 'OK';
  }

  async close(): Promise<void> {
    if (this.#owned) this.#client.close();
  }
}

/** Rejects with a timeout error when `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
