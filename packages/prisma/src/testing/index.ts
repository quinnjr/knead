import type { Token } from '@knead-js/core';
import { TransactionHost } from '../transaction-host.js';

const ROLLBACK = Symbol('knead:prisma:rollback');

/**
 * Runs `fn` inside a transaction that is always rolled back, resolving with `fn`'s value.
 * `ctx` is anything with a `get(token)`, such as a `TestingModule` or `ApplicationContext`.
 * Errors thrown by `fn` propagate unchanged.
 */
export async function withRollback<R>(
  ctx: { get<T>(token: Token<T>): T },
  fn: () => Promise<R>,
  options: { timeout?: number } = {},
): Promise<R> {
  const host = ctx.get(TransactionHost);
  let result: R | undefined;
  try {
    await host.run(
      async () => {
        result = await fn();
        throw ROLLBACK;
      },
      { timeout: options.timeout ?? 30_000, propagation: 'requiresNew' },
    );
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result as R;
}
