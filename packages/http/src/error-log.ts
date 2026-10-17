import { inject, redactCredentials, redactValue, summarizeError } from '@knead-js/core';
import { LOGGER, type Logger } from './logger.js';

export { LOGGED_MESSAGE_LENGTH, summarizeError } from '@knead-js/core';

import { HTTP_DEVELOPMENT } from './tokens.js';

export interface ErrorLogOptions {
  readonly logger: Logger;
  /** The application's HTTP_DEVELOPMENT flag. */
  readonly development: boolean;
}

/**
 * Logs an error under a new correlation id and returns the id. In development the full error is
 * logged, redacted (redactValue). Otherwise only `Name: message` (summarizeError) is logged: no
 * stack, cause or properties, which tend to hold request data. The message is redacted either
 * way, so this holds whatever LOGGER is configured.
 */
export function logError(
  options: ErrorLogOptions,
  message: string,
  error: unknown,
  level: 'error' | 'warn' = 'error',
): string {
  const id = crypto.randomUUID();
  try {
    const text = `${redactCredentials(message)} (correlation id ${id})`;
    if (options.development) options.logger[level](text, redactValue(error));
    else options.logger[level](`${text}: ${summarizeError(error)}`);
  } catch {
    // A failing logger must not turn an error response into another error (or Bun's
    // development error page).
  }
  return id;
}

/** Injectable logError(), with LOGGER and HTTP_DEVELOPMENT. */
export class ErrorLog implements ErrorLogOptions {
  readonly logger = inject(LOGGER);
  readonly development: boolean =
    inject(HTTP_DEVELOPMENT, { optional: true }) ?? process.env.NODE_ENV === 'development';

  /** See logError(). Returns the correlation id. */
  log(message: string, error: unknown, level: 'error' | 'warn' = 'error'): string {
    return logError(this, message, error, level);
  }
}
