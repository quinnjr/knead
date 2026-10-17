// A hand-written stand-in for the client `prisma generate` writes from the schema on the database
// guide. It declares only the types the examples use; a real generated client implements them.
import type { SqlDriverAdapterFactory } from '@prisma/client/runtime/client';

// #region models
export interface User {
  id: number;
  email: string;
  name: string | null;
}

export interface Order {
  id: number;
  userId: number;
  total: number;
}

export interface AuditEntry {
  id: number;
  action: string;
}
// #endregion models

export interface UserDelegate {
  findUnique(args: { where: { id: number } | { email: string } }): Promise<User | null>;
  create(args: { data: { email: string; name?: string | null } }): Promise<User>;
  count(): Promise<number>;
}

export interface OrderDelegate {
  create(args: { data: { userId: number; total: number } }): Promise<Order>;
}

export interface AuditEntryDelegate {
  create(args: { data: { action: string } }): Promise<AuditEntry>;
}

export interface TransactionOptions {
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  maxWait?: number;
  timeout?: number;
}

export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export class PrismaClient {
  declare user: UserDelegate;
  declare order: OrderDelegate;
  declare auditEntry: AuditEntryDelegate;
  declare $connect: () => Promise<void>;
  declare $disconnect: () => Promise<void>;
  declare $on: (event: 'query', callback: (event: { query: string }) => void) => void;
  declare $transaction: <R>(
    fn: (tx: TransactionClient) => Promise<R>,
    options?: TransactionOptions,
  ) => Promise<R>;

  // biome-ignore lint/complexity/noUselessConstructor: types the generated constructor's options
  constructor(_options: { adapter: SqlDriverAdapterFactory }) {}
}
