import { inject } from '@knead-js/core';
import { PrismaService, Transactional } from '../src/index.js';

// Augments the public entry, exactly as the README tells users to.
declare module '../src/index.js' {
  interface PrismaClientRegistry {
    client: {
      user: { findMany(): Promise<{ id: number }[]> };
      $connect(): Promise<void>;
      $disconnect(): Promise<void>;
      $transaction<R>(fn: (tx: never) => Promise<R>, options?: unknown): Promise<R>;
      $on(event: 'query', cb: () => void): void;
    };
  }
}

export function check(): void {
  const service = inject(PrismaService);
  const users: Promise<{ id: number }[]> = service.db.user.findMany();
  void users;
  // @ts-expect-error transactions go through TransactionHost
  service.db.$transaction;
  // @ts-expect-error lifecycle is owned by PrismaService
  service.db.$connect;
  // @ts-expect-error event hooks are not available on a tx client
  service.db.$on;
  service.client.$on('query', () => {});
}

export class TransactionalTypes {
  @Transactional({ isolationLevel: 'Serializable', propagation: 'requiresNew' })
  async ok(): Promise<number> {
    return 1;
  }

  // @ts-expect-error @Transactional needs a method that returns a Promise
  @Transactional()
  sync(): number {
    return 1;
  }

  // @ts-expect-error unknown propagation mode
  @Transactional({ propagation: 'nested' })
  async badPropagation(): Promise<void> {}
}
