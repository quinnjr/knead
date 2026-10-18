import {
  DEVELOPMENT,
  Injectable,
  InjectionToken,
  inject,
  LOGGER,
  logError,
  logValue,
  Module,
  redactCredentials,
} from '@knead-js/core';

export const REDIS_URL = new InjectionToken<string>('REDIS_URL');

// #region inject
@Injectable()
export class CacheWarmer {
  readonly #log = inject(LOGGER);
  readonly #development = inject(DEVELOPMENT);
  readonly #url = inject(REDIS_URL);

  async warm(keys: string[], load: (key: string) => Promise<void>): Promise<string | undefined> {
    // redactCredentials turns redis://user:pass@host into redis://***@host.
    this.#log.info(`warming ${keys.length} keys from ${redactCredentials(this.#url)}`);
    for (const key of keys) {
      try {
        await load(key);
      } catch (error) {
        // logError returns the correlation id it logged, to show to an operator or a client.
        return logError(
          { logger: this.#log, development: this.#development },
          `Warming ${logValue(key)} failed`,
          error,
          'warn',
        );
      }
    }
    return undefined;
  }
}
// #endregion inject

@Module({
  providers: [
    { provide: REDIS_URL, useValue: 'redis://cache:hunter2@cache.internal:6379' },
    CacheWarmer,
  ],
})
export class CacheModule {}
