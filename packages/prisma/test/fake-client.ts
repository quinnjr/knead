import type { PrismaLike, RegisteredClient } from '../src/types.js';

export interface FakeTransaction {
  options?: unknown;
  outcome: 'commit' | 'rollback';
  tx: { id: number };
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
    async $transaction<R>(fn: (tx: { id: number }) => Promise<R>, options?: unknown): Promise<R> {
      const record: FakeTransaction = { options, outcome: 'commit', tx: { id: nextId++ } };
      transactions.push(record);
      calls.push('$transaction');
      try {
        const result = await fn(record.tx);
        calls.push('commit');
        return result;
      } catch (error) {
        record.outcome = 'rollback';
        calls.push('rollback');
        throw error;
      }
    },
  };
  return fake as FakeClient & RegisteredClient;
}
