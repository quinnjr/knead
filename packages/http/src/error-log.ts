import { type ErrorLogOptions, Injectable, inject, LOGGER, logError } from '@knead-js/core';
import { HTTP_DEVELOPMENT } from './tokens.js';

export {
  type ErrorLogOptions,
  LOGGED_MESSAGE_LENGTH,
  logError,
  summarizeError,
} from '@knead-js/core';

/** Injectable logError(), with LOGGER and HTTP_DEVELOPMENT. */
@Injectable()
export class ErrorLog implements ErrorLogOptions {
  readonly logger = inject(LOGGER);
  readonly development: boolean = inject(HTTP_DEVELOPMENT);

  /** See logError(). Returns the correlation id. */
  log(message: string, error: unknown, level: 'error' | 'warn' = 'error'): string {
    return logError(this, message, error, level);
  }
}
