import {
  DEVELOPMENT,
  inject,
  KneadError,
  LOGGER,
  logError,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@knead-js/core';
import { PRISMA_CLIENT, PRISMA_OPTIONS } from './tokens.js';
import type { RegisteredClient, TxClient } from './types.js';

export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /** The raw client. Prefer `db`, which joins the ambient transaction. */
  readonly client: RegisteredClient = inject(PRISMA_CLIENT);
  readonly #options = inject(PRISMA_OPTIONS);
  readonly #logger = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);

  /** The client to query through. */
  get db(): TxClient {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.$connect();
    } catch (error) {
      logError(
        { logger: this.#logger, development: this.#development },
        'Prisma failed to connect',
        error,
      );
      if (this.#owned()) {
        try {
          await this.client.$disconnect();
        } catch {
          // Best effort: the connect error is the one worth reporting.
        }
      }
      const failure = new KneadError('Prisma failed to connect to the database');
      failure.cause = error;
      throw failure;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#owned() || this.#disconnectOnShutdown()) await this.client.$disconnect();
  }

  /** Whether the module built the client (a `client` factory) rather than borrowing an instance. */
  #owned(): boolean {
    return typeof (this.#options as { client?: unknown }).client === 'function';
  }

  #disconnectOnShutdown(): boolean {
    return (this.#options as { disconnectOnShutdown?: boolean }).disconnectOnShutdown === true;
  }
}
