import { redactCredentials, redactValue, summarizeError } from './log-redaction.js';
import type { Logger } from './logger.js';

export interface ErrorLogOptions {
  readonly logger: Logger;
  /** The application's DEVELOPMENT flag. */
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
