import { inject } from '@knead-js/core';
import { Transactional, TransactionHost } from '@knead-js/prisma';
import { AuditLog, OrdersRepository, UsersRepository } from './users.repository.js';

export interface SignUp {
  email: string;
  name: string | null;
  firstOrderTotal: number;
}

// #region transactional
export class SignupService {
  readonly #users = inject(UsersRepository);
  readonly #orders = inject(OrdersRepository);
  readonly #audit = inject(AuditLog);

  // Both writes commit together, or neither does.
  @Transactional()
  async signUp(input: SignUp) {
    const user = await this.#users.create(input.email, input.name);
    await this.#orders.create(user.id, input.firstOrderTotal);
    await this.#audit.record(`user.created:${user.id}`);
    return user;
  }
}
// #endregion transactional

// #region run
export class ImportService {
  readonly #host = inject(TransactionHost);
  readonly #users = inject(UsersRepository);
  readonly #audit = inject(AuditLog);

  importUsers(emails: string[]) {
    return this.#host.run(
      async () => {
        for (const email of emails) await this.#users.create(email, null);
        return this.#users.count();
      },
      { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 2_000 },
    );
  }

  // The audit entry commits on its own transaction, even if the caller's transaction rolls back.
  recordAttempt(action: string) {
    return this.#host.run(() => this.#audit.record(action), { propagation: 'requiresNew' });
  }
}
// #endregion run
