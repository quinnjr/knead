import {
  DEVELOPMENT,
  type DynamicModule,
  InjectionToken,
  inject,
  LOGGER,
  MODULES,
  Module,
} from '@knead-js/core';
import {
  JsonLogger,
  type JsonLoggerOptions,
  LoggingConfigError,
  validateJsonLoggerOptions,
} from './json-logger.js';

/** forRoot()'s options, provided only inside the module forRoot() returns (never exported). */
const LOGGING_OPTIONS = new InjectionToken<JsonLoggerOptions>('knead:logging:options');
const LOGGING_SETUP = new InjectionToken<true>('knead:logging:setup');

/**
 * Fails startup when LoggingModule is imported without forRoot() (which would silently keep the
 * default logger) or when forRoot() is imported more than once (modules would disagree on which
 * LOGGER they see).
 */
function checkSetup(): true {
  if (inject(LOGGING_OPTIONS, { optional: true }) === undefined) {
    throw new LoggingConfigError('Import LoggingModule.forRoot(), not LoggingModule');
  }
  const count = inject(MODULES).filter((m) => m.metatype === LoggingModule).length;
  if (count > 1) {
    throw new LoggingConfigError(
      `LoggingModule.forRoot() is imported ${count} times; import it once, in the root module`,
    );
  }
  return true;
}

@Module({ providers: [{ provide: LOGGING_SETUP, useFactory: checkSetup }] })
export class LoggingModule {
  /**
   * Makes a JsonLogger the application's LOGGER in every module. `development` defaults to the
   * application's DEVELOPMENT flag. Invalid options are a LoggingConfigError here, at startup.
   * Use childLogger(inject(LOGGER), fields) for per-component fields: it keeps working when
   * LOGGER is replaced (KneadFactory's `logger` option, @knead-js/testing).
   */
  static forRoot(options: JsonLoggerOptions = {}): DynamicModule {
    validateJsonLoggerOptions(options);
    return {
      module: LoggingModule,
      global: true,
      providers: [
        { provide: LOGGING_OPTIONS, useValue: options },
        {
          provide: LOGGER,
          useFactory: () =>
            new JsonLogger({
              ...options,
              development: options.development ?? inject(DEVELOPMENT),
            }),
        },
      ],
      exports: [LOGGER],
    };
  }
}
