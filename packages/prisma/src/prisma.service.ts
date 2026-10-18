import {
  DEVELOPMENT,
  Injectable,
  inject,
  KneadError,
  LOGGER,
  logError,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@knead-js/core';
import { isFactoryOptions } from './options.js';
import { PRISMA_CLIENT, PRISMA_OPTIONS } from './tokens.js';
import { TransactionHost } from './transaction-host.js';
import type { RegisteredClient, TxClient } from './types.js';

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,99}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `Name (code)` for a production log: the error's name and its `code` or `errorCode`, each only
 * when it looks like an identifier. Never the message, which can hold a connection string.
 */
function describeConnectError(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const name = typeof e.name === 'string' && IDENTIFIER.test(e.name) ? e.name : 'Error';
  const raw = e.code ?? e.errorCode;
  const code =
    (typeof raw === 'string' && ERROR_CODE.test(raw)) || Number.isInteger(raw)
      ? String(raw)
      : undefined;
  return code === undefined ? name : `${name} (${code})`;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /** The raw client. Prefer `db`, which joins the ambient transaction. */
  readonly client: RegisteredClient = inject(PRISMA_CLIENT);
  readonly #options = inject(PRISMA_OPTIONS);
  readonly #logger = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);
  readonly #host = inject(TransactionHost);

  /** The client to query through: the ambient transaction when one is active, else `client`. */
  get db(): TxClient {
    return this.#host.current ?? this.client;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.$connect();
    } catch (error) {
      this.#logConnectError(error);
      if (isFactoryOptions(this.#options)) {
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
    const options = this.#options;
    if (isFactoryOptions(options) || options.disconnectOnShutdown === true) {
      await this.client.$disconnect();
    }
  }

  /**
   * In development, the full error redacted (logError). Otherwise only its name and code: driver
   * messages can carry connection strings and hosts.
   */
  #logConnectError(error: unknown): void {
    try {
      if (this.#development) {
        logError({ logger: this.#logger, development: true }, 'Prisma failed to connect', error);
      } else {
        this.#logger.error(`Prisma failed to connect: ${describeConnectError(error)}`);
      }
    } catch {
      // A failing logger must not mask the connect error.
    }
  }
}
