/**
 * Loads the generated fixture client at run time. The import uses a computed specifier so
 * `pnpm typecheck` and `pnpm test` pass when nothing has been generated.
 */

export interface FixtureUser {
  id: number;
  email: string;
}

export interface FixturePost {
  id: number;
  authorId: number;
}

/** The slice of the generated client (or a transaction client) the integration suite uses. */
export interface FixtureDb {
  user: {
    create(args: { data: { email: string } }): Promise<FixtureUser>;
    count(args?: { where?: { email?: string } }): Promise<number>;
    deleteMany(): Promise<{ count: number }>;
  };
  post: {
    create(args: { data: { authorId: number } }): Promise<FixturePost>;
    count(): Promise<number>;
    deleteMany(): Promise<{ count: number }>;
  };
}

export interface FixtureClient extends FixtureDb {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<R>(fn: (tx: FixtureDb) => Promise<R>, options?: unknown): Promise<R>;
}

export type FixtureClientCtor = new (opts: { adapter: unknown }) => FixtureClient;

export async function loadClient(): Promise<FixtureClientCtor> {
  const path = new URL('./generated/client.ts', import.meta.url).href;
  const mod = (await import(path)) as { PrismaClient: FixtureClientCtor };
  return mod.PrismaClient;
}

/** Builds a `@prisma/adapter-pg` adapter (a devDependency, imported only when the suite runs). */
export async function loadAdapter(connectionString: string): Promise<unknown> {
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return new PrismaPg({ connectionString });
}
