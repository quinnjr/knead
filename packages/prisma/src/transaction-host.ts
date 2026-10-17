import { AsyncLocalStorage } from 'node:async_hooks';
import { DEVELOPMENT, inject, KneadError, LOGGER } from '@knead-js/core';
import { PRISMA_CLIENT } from './tokens.js';
import type { IsolationLevel, PrismaLike, TransactionOptions, TxClient } from './types.js';

export type Propagation = 'required' | 'requiresNew';

export interface RunOptions extends TransactionOptions {
  /**
   * `'required'` (default) joins the active transaction. `'requiresNew'` always opens a separate
   * transaction on another connection, which needs a pool size of at least 2 and can deadlock
   * against the outer one.
   */
  propagation?: Propagation;
}

interface TxFrame {
  tx: TxClient;
  options: TransactionOptions;
  /** False once the transaction's callback has settled. */
  open: boolean;
  /** Set when a joined run rejected: the owner must not commit. */
  rollbackOnly: boolean;
  /** The first rejection of a joined run. */
  failure?: unknown;
}

const OPTION_KEYS = ['isolationLevel', 'timeout', 'maxWait'] as const;

const PROPAGATIONS: ReadonlySet<unknown> = new Set<Propagation>(['required', 'requiresNew']);
const ISOLATION_LEVELS: ReadonlySet<unknown> = new Set<IsolationLevel>([
  'ReadUncommitted',
  'ReadCommitted',
  'RepeatableRead',
  'Serializable',
  'Snapshot',
]);

/** Throws a KneadError unless `propagation` is undefined, `'required'` or `'requiresNew'`. */
export function assertPropagation(propagation: unknown): void {
  if (propagation !== undefined && !PROPAGATIONS.has(propagation)) {
    throw new KneadError(
      `TransactionHost: unknown propagation ${JSON.stringify(propagation)}; use 'required' or 'requiresNew'.`,
    );
  }
}

/** Throws a KneadError unless `isolationLevel` is undefined or a Prisma isolation level. */
export function assertIsolationLevel(isolationLevel: unknown): void {
  if (isolationLevel !== undefined && !ISOLATION_LEVELS.has(isolationLevel)) {
    throw new KneadError(
      `TransactionHost: unknown isolationLevel ${JSON.stringify(isolationLevel)}; use one of ${[...ISOLATION_LEVELS].join(', ')}.`,
    );
  }
}

/** Runs work inside an ambient Prisma interactive transaction. One per application. */
export class TransactionHost {
  readonly #als = new AsyncLocalStorage<TxFrame>();
  readonly #client = inject(PRISMA_CLIENT) as unknown as PrismaLike;
  readonly #logger = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);

  /**
   * Runs `fn` in a transaction: commits when it resolves, rolls back when it rejects and rethrows
   * the rejection unchanged. Joins the active transaction unless `propagation` is `'requiresNew'`.
   * A joined run that rejects marks the shared transaction rollback-only: even if the owner
   * catches that rejection and resolves, the transaction rolls back and the owning run rejects
   * with a KneadError whose `cause` is the inner rejection.
   */
  run<R>(fn: () => Promise<R>, options: RunOptions = {}): Promise<R> {
    try {
      assertPropagation(options.propagation);
    } catch (error) {
      return Promise.reject(error);
    }
    const frame = this.#open();
    const txOptions = pick(options);
    if (frame && options.propagation !== 'requiresNew') {
      if (this.#development && !sameOptions(frame.options, txOptions)) {
        this.#logger.warn(
          'TransactionHost: joined an active transaction with different options; the inner options are ignored',
          { active: frame.options, requested: txOptions },
        );
      }
      // Async wrapper so a synchronous throw still surfaces as a rejection.
      return (async () => {
        try {
          return await fn();
        } catch (error) {
          if (!frame.rollbackOnly) {
            frame.rollbackOnly = true;
            frame.failure = error;
          }
          throw error;
        }
      })();
    }
    return this.#client.$transaction(async (tx: TxClient) => {
      const next: TxFrame = { tx, options: txOptions, open: true, rollbackOnly: false };
      try {
        const result = await this.#als.run(next, fn);
        if (next.rollbackOnly) {
          // Thrown inside the callback so Prisma rolls back instead of committing.
          const error = new KneadError(
            'TransactionHost: transaction marked rollback-only by an inner failure',
          );
          error.cause = next.failure;
          throw error;
        }
        return result;
      } finally {
        next.open = false;
      }
    }, txOptions);
  }

  /** Whether a transaction is active in the current async context. */
  get isActive(): boolean {
    return this.#open() !== undefined;
  }

  /**
   * The transaction client of the current async context, including one whose callback has
   * settled (so late work fails loudly in Prisma instead of escaping the transaction).
   * @internal
   */
  get current(): TxClient | undefined {
    return this.#als.getStore()?.tx;
  }

  #open(): TxFrame | undefined {
    const frame = this.#als.getStore();
    return frame?.open ? frame : undefined;
  }
}

function pick(options: RunOptions): TransactionOptions {
  const out: Record<string, unknown> = {};
  for (const key of OPTION_KEYS) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out as TransactionOptions;
}

function sameOptions(a: TransactionOptions, b: TransactionOptions): boolean {
  return OPTION_KEYS.every((key) => b[key] === undefined || a[key] === b[key]);
}
