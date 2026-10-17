import {
  ConsoleLogger,
  DeferredLogger,
  defaultRedisUrl,
  plaintextRedisHost,
  sendRedisCommand,
  type WarnLogger,
} from '@knead-js/core';
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
  /**
   * Where warnings go. Without it, the construction warnings are held until ScheduleModule
   * passes its logger (setLogger()), or go to a `ConsoleLogger` at the first acquire() when the
   * store is used on its own.
   */
  logger?: WarnLogger;
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
  readonly #log: DeferredLogger;

  constructor(options: RedisLockStoreOptions = {}) {
    const timeout = options.commandTimeout ?? 250;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new ScheduleConfigError(
        `commandTimeout must be an integer >= 1 (ms), got ${String(timeout)}.`,
      );
    }
    this.#commandTimeout = timeout;
    this.#log = new DeferredLogger(options.logger, () => new ConsoleLogger());
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
      this.#log.warn(`[knead:schedule] ${problem}`);
    }
    this.#owned = options.client === undefined;
    // Without the offline queue a timed-out SET is never sent later, after the firing was
    // reported as skipped.
    this.#client = options.client ?? new RedisClient(options.url, { enableOfflineQueue: false });
    this.#prefix = options.prefix ?? 'knead:schedule:';
  }

  /**
   * Sets where warnings go when no `logger` option was given, and delivers the warnings held
   * since construction. ScheduleModule calls it with its logger.
   */
  setLogger(logger: WarnLogger): void {
    this.#log.attach(logger);
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    assertLockTtl(ttlMs);
    // Used without ScheduleModule: nobody will call setLogger().
    this.#log.use();
    const args = [`${this.#prefix}${key}`, '1', 'NX', 'PX', String(ttlMs)];
    // A SET sent after the timeout could claim a firing that was already reported skipped.
    const reply = await sendRedisCommand(
      this.#client,
      () => this.#client.send('SET', args),
      this.#commandTimeout,
    );
    return reply === 'OK';
  }

  async close(): Promise<void> {
    if (this.#owned) this.#client.close();
  }
}
