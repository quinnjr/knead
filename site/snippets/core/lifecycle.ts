import {
  type BeforeApplicationShutdown,
  InjectionToken,
  inject,
  LOGGER,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@knead-js/core';

export const EVENTS = new InjectionToken<string[]>('EVENTS');

// #region hooks
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly #events = inject(EVENTS);
  connected = false;

  async onModuleInit(): Promise<void> {
    await Bun.sleep(1); // open the connection pool
    this.connected = true;
    this.#events.push('Database.onModuleInit');
  }

  async onModuleDestroy(): Promise<void> {
    this.connected = false;
    this.#events.push('Database.onModuleDestroy');
  }
}

export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly #db = inject(Database);
  readonly #events = inject(EVENTS);
  readonly #log = inject(LOGGER);

  onApplicationBootstrap(): void {
    // Every onModuleInit has finished, so the database is connected.
    this.#events.push(`JobRunner.onApplicationBootstrap connected=${this.#db.connected}`);
  }

  beforeApplicationShutdown(signal?: string): void {
    this.#log.info(`stopping jobs (${signal ?? 'no signal'})`);
    this.#events.push(`JobRunner.beforeApplicationShutdown ${signal}`);
  }
}
// #endregion hooks

@Module({
  providers: [{ provide: EVENTS, useValue: [] }, JobRunner, Database],
})
export class WorkerModule {}
