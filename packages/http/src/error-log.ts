import { inject } from '@knead/core';
import { LOGGER, type Logger, logValue, redactCredentials, redactValue } from './logger.js';
import { HTTP_DEVELOPMENT } from './tokens.js';

/** Longest error message logged outside development. */
export const LOGGED_MESSAGE_LENGTH = 500;

/** A URL scheme with no `@` after it, at the end of a truncated message. */
const TRAILING_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/[^@\s]*$/i;

/**
 * `Name: message` for logs outside development: the message is redacted first (so a truncation
 * cannot cut a credential URL in half and leave its password prefix behind), then capped at 500
 * characters, then a trailing `scheme://…` fragment without an `@` is removed, then control
 * characters are escaped. No stack, cause or properties.
 */
export function summarizeError(error: unknown): string {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : undefined;
  let name: string;
  let message: string;
  try {
    name = typeof record?.name === 'string' ? record.name : record ? 'Error' : typeof error;
    message = typeof record?.message === 'string' ? record.message : String(error);
  } catch {
    name = 'Error';
    message = '(unprintable)';
  }
  message = redactCredentials(message);
  if (message.length > LOGGED_MESSAGE_LENGTH) {
    message = `${message.slice(0, LOGGED_MESSAGE_LENGTH).replace(TRAILING_URL, '')}…`;
  }
  return `${logValue(name)}: ${logValue(message)}`;
}

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
