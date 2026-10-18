import { KneadError, type Token } from '@knead-js/core';
import { pendingRollbackOnlyError, TransactionHost } from '../transaction-host.js';

const ROLLBACK = Symbol('knead:prisma:rollback');

/**
 * Runs `fn` inside a transaction that is always rolled back, resolving with `fn`'s value.
 * `ctx` is anything with a `get(token)`, such as a `TestingModule` or `ApplicationContext`.
 * Errors thrown by `fn` propagate unchanged. Inner `@Transactional` calls and `run()`s join the
 * transaction, so like any owning run it rejects with the rollback-only KneadError (its `cause`
 * the inner rejection) when one of them rejected, even if `fn` caught it. Fails closed: if the
 * client never ran `fn` or did not reject with the rollback signal (so the rollback cannot be
 * confirmed), it throws a KneadError instead of resolving.
 */
export async function withRollback<R>(
  ctx: { get<T>(token: Token<T>): T },
  fn: () => Promise<R>,
  options: { timeout?: number } = {},
): Promise<R> {
  const host = ctx.get(TransactionHost);
  let ran = false;
  let rolledBack = false;
  let result: R | undefined;
  let rollbackOnly: KneadError | undefined;
  try {
    await host.run(
      async () => {
        ran = true;
        result = await fn();
        rollbackOnly = pendingRollbackOnlyError(host);
        throw ROLLBACK;
      },
      { timeout: options.timeout ?? 30_000, propagation: 'requiresNew' },
    );
  } catch (error) {
    if (error !== ROLLBACK) throw error;
    rolledBack = true;
  }
  if (!ran || !rolledBack) throw new KneadError('withRollback: rollback not confirmed');
  if (rollbackOnly) throw rollbackOnly;
  return result as R;
}
