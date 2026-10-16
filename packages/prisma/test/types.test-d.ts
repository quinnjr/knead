import { inject } from '@knead-js/core';
import { PrismaService } from '../src/index.js';

declare module '../src/types.js' {
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
