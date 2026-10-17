import { redactCredentials, redactValue, summarizeError } from './log-redaction.js';
import type { Logger } from './logger.js';

export interface ErrorLogOptions {
  readonly logger: Logger;
  /** The application's DEVELOPMENT flag. */
  readonly development: boolean;
}

/**
 * Logs an error under a new correlation id and returns the id. In development the full error is
 * logged, redacted (redactValue); an Error stays an Error (one whose text is the redacted stack,
 * causes and properties when anything needed redacting), so a logger formats every error alike. Otherwise only `Name: message` (summarizeError) is logged: no
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
    if (options.development) options.logger[level](text, redactedError(error));
    else options.logger[level](`${text}: ${summarizeError(error)}`);
  } catch {
    // A failing logger must not turn an error response into another error (or Bun's
    // development error page).
  }
  return id;
}

/**
 * redactValue(error), except that an Error it had to redact (which redactValue turns into its
 * redacted text) comes back as an Error with that text as its stack and the redacted message.
 */
function redactedError(error: unknown): unknown {
  const redacted = redactValue(error);
  if (!(error instanceof Error) || typeof redacted !== 'string') return redacted;
  try {
    const copy = new Error(redactCredentials(String(error.message)));
    Object.defineProperty(copy, 'name', { value: error.name, enumerable: false });
    Object.defineProperty(copy, 'stack', { value: redacted, enumerable: false });
    return copy;
  } catch {
    // A throwing message or name getter: log the redacted text rather than nothing.
    return redacted;
  }
}
