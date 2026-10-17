import type { PrismaLike, RegisteredClient } from '../src/types.js';

/** A fake transaction client. Like Prisma's, it fails once its transaction has settled. */
export interface FakeTx {
  id: number;
  query(): Promise<number>;
}

export interface FakeTransaction {
  options?: unknown;
  outcome: 'commit' | 'rollback';
  tx: FakeTx;
}

export interface FakeClientOptions {
  /** `$connect` rejects with this error. */
  connectError?: Error;
}

export interface FakeClient extends PrismaLike {
  readonly calls: string[];
  readonly transactions: FakeTransaction[];
}

/** A recording stand-in for a PrismaClient, typed as the registered client. */
export function createFakeClient(opts: FakeClientOptions = {}): FakeClient & RegisteredClient {
  const calls: string[] = [];
  const transactions: FakeTransaction[] = [];
  let nextId = 1;
  const fake: FakeClient = {
    calls,
    transactions,
    async $connect() {
      calls.push('$connect');
      if (opts.connectError) throw opts.connectError;
    },
    async $disconnect() {
      calls.push('$disconnect');
    },
    async $transaction<R>(fn: (tx: FakeTx) => Promise<R>, options?: unknown): Promise<R> {
      const id = nextId++;
      let settled = false;
      const tx: FakeTx = {
        id,
        async query() {
          if (settled) throw new Error(`Transaction ${id} already closed`);
          return id;
        },
      };
      const record: FakeTransaction = { options, outcome: 'commit', tx };
      transactions.push(record);
      calls.push('$transaction');
      try {
        const result = await fn(tx);
        calls.push('commit');
        return result;
      } catch (error) {
        record.outcome = 'rollback';
        calls.push('rollback');
        throw error;
      } finally {
        settled = true;
      }
    },
  };
  return fake as FakeClient & RegisteredClient;
}
