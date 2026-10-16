import { escapeControl, InjectionToken, redactCredentials, redactValue } from '@knead-js/core';

export {
  logValue,
  MAX_LOGGED_VALUE_LENGTH,
  redactCredentials,
  redactValue,
} from '@knead-js/core';

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const LOGGER = new InjectionToken<Logger>('LOGGER');

/**
 * Logs to the console. Credentials (see redactCredentials) in the message, in string meta and in
 * objects, arrays and Errors (messages, stacks, causes and own properties, see redactValue) are
 * printed redacted; the originals are not modified. Control characters (CR, LF, ESC, ...) in the
 * message and in string meta are escaped, so a logged value cannot start a forged log line.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = 'knead') {}

  debug(message: string, ...meta: unknown[]): void {
    try {
      console.debug(...this.#format(message, meta));
    } catch {
      // Never let a console failure surface to the caller.
    }
  }
  info(message: string, ...meta: unknown[]): void {
    try {
      console.info(...this.#format(message, meta));
    } catch {
      // Never let a console failure surface to the caller.
    }
  }
  warn(message: string, ...meta: unknown[]): void {
    try {
      console.warn(...this.#format(message, meta));
    } catch {
      // Never let a console failure surface to the caller.
    }
  }
  error(message: string, ...meta: unknown[]): void {
    try {
      console.error(...this.#format(message, meta));
    } catch {
      // Never let a console failure surface to the caller.
    }
  }

  #format(message: string, meta: unknown[]): unknown[] {
    try {
      return this.#formatUnsafe(message, meta);
    } catch {
      // Logging must never throw into the caller (for example, a request's error handler).
      return [`[${this.prefix}] ${escapeControl(String(message))}`, '[unloggable arguments]'];
    }
  }

  #formatUnsafe(message: string, meta: unknown[]): unknown[] {
    return [
      `[${this.prefix}] ${escapeControl(redactCredentials(message))}`,
      ...meta.map((value) =>
        typeof value === 'string' ? escapeControl(redactCredentials(value)) : redactValue(value),
      ),
    ];
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  meta: unknown[];
}

/**
 * Records log entries in memory, for tests only: entries are kept exactly as logged, without
 * redaction, so never use it (or expose its entries) in production.
 */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(message: string, ...meta: unknown[]): void {
    this.entries.push({ level: 'debug', message, meta });
  }
  info(message: string, ...meta: unknown[]): void {
    this.entries.push({ level: 'info', message, meta });
  }
  warn(message: string, ...meta: unknown[]): void {
    this.entries.push({ level: 'warn', message, meta });
  }
  error(message: string, ...meta: unknown[]): void {
    this.entries.push({ level: 'error', message, meta });
  }
  clear(): void {
    this.entries.length = 0;
  }
}
