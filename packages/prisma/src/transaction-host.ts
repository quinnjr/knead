import { AsyncLocalStorage } from 'node:async_hooks';
import { DEVELOPMENT, inject, LOGGER } from '@knead-js/core';
import { PRISMA_CLIENT } from './tokens.js';
import type { PrismaLike, TransactionOptions, TxClient } from './types.js';

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
}

const OPTION_KEYS = ['isolationLevel', 'timeout', 'maxWait'] as const;

/** Runs work inside an ambient Prisma interactive transaction. One per application. */
export class TransactionHost {
  readonly #als = new AsyncLocalStorage<TxFrame>();
  readonly #client = inject(PRISMA_CLIENT) as unknown as PrismaLike;
  readonly #logger = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);

  /**
   * Runs `fn` in a transaction: commits when it resolves, rolls back when it rejects and rethrows
   * the rejection unchanged. Joins the active transaction unless `propagation` is `'requiresNew'`.
   */
  run<R>(fn: () => Promise<R>, options: RunOptions = {}): Promise<R> {
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
      return (async () => fn())();
    }
    return this.#client.$transaction(async (tx: TxClient) => {
      const next: TxFrame = { tx, options: txOptions, open: true };
      try {
        return await this.#als.run(next, fn);
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
