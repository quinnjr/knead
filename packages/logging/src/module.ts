import { DEVELOPMENT, type DynamicModule, inject, LOGGER, Module } from '@knead-js/core';
import { JsonLogger, type JsonLoggerOptions, validateJsonLoggerOptions } from './json-logger.js';

@Module({})
export class LoggingModule {
  /**
   * Makes a JsonLogger the application's LOGGER, injectable everywhere as LOGGER or as
   * JsonLogger (for child()). `development` defaults to the application's DEVELOPMENT flag.
   * Invalid options are a LoggingConfigError here, at startup.
   */
  static forRoot(options: JsonLoggerOptions = {}): DynamicModule {
    validateJsonLoggerOptions(options);
    return {
      module: LoggingModule,
      global: true,
      providers: [
        {
          provide: JsonLogger,
          useFactory: () =>
            new JsonLogger({
              ...options,
              development: options.development ?? inject(DEVELOPMENT),
            }),
        },
        { provide: LOGGER, useExisting: JsonLogger },
      ],
      exports: [JsonLogger, LOGGER],
    };
  }
}
