import { Injectable, inject } from '@knead-js/core';
import { PrismaService } from '@knead-js/prisma';

// #region repository
@Injectable()
export class UsersRepository {
  readonly #prisma = inject(PrismaService);

  findById(id: number) {
    // db is the ambient transaction's client inside a transaction, the base client otherwise.
    return this.#prisma.db.user.findUnique({ where: { id } });
  }

  create(email: string, name: string | null) {
    return this.#prisma.db.user.create({ data: { email, name } });
  }

  count() {
    return this.#prisma.db.user.count();
  }
}
// #endregion repository

@Injectable()
export class OrdersRepository {
  readonly #prisma = inject(PrismaService);

  create(userId: number, total: number) {
    return this.#prisma.db.order.create({ data: { userId, total } });
  }
}

@Injectable()
export class AuditLog {
  readonly #prisma = inject(PrismaService);

  record(action: string) {
    return this.#prisma.db.auditEntry.create({ data: { action } });
  }
}
