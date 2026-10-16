/**
 * Users merge their generated client into this registry so the integration is typed without
 * importing the Prisma package:
 *
 * ```ts
 * declare module '@knead-js/prisma' {
 *   interface PrismaClientRegistry {
 *     client: PrismaClient;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface PrismaClientRegistry {}

export type IsolationLevel =
  | 'ReadUncommitted'
  | 'ReadCommitted'
  | 'RepeatableRead'
  | 'Serializable'
  | 'Snapshot';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /** Maximum time the transaction may run, in milliseconds. */
  timeout?: number;
  /** Maximum time to wait for a connection, in milliseconds. */
  maxWait?: number;
}

/** The minimal client shape the integration relies on when no client type is registered. */
export interface PrismaLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<R>(fn: (tx: any) => Promise<R>, options?: TransactionOptions): Promise<R>;
}

export type RegisteredClient = PrismaClientRegistry extends { client: infer C } ? C : PrismaLike;

/** The registered client minus lifecycle, event and transaction members. */
export type TxClient = Omit<
  RegisteredClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export type PrismaModuleOptions =
  | { client: () => RegisteredClient | Promise<RegisteredClient> }
  | { instance: RegisteredClient; disconnectOnShutdown?: boolean };
