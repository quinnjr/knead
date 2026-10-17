import { escapeControl, redactCredentials, redactValue } from './log-redaction.js';
import { InjectionToken } from './tokens.js';

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const LOGGER = new InjectionToken<Logger>('LOGGER');

/** The part of a logger that DeferredLogger forwards to. */
export type WarnLogger = Pick<Logger, 'warn'>;

/**
 * Warnings of an object built outside dependency injection, such as a store passed in module
 * options. They are held until attach() gives it a logger (a module passes the application's
 * LOGGER) and forwarded from then on. Without attach(), use() sends them to `fallback` instead.
 */
export class DeferredLogger implements WarnLogger {
  #target: WarnLogger | undefined;
  #pending: string[] = [];

  /** `target`: an explicit logger, which attach() then never replaces. */
  constructor(
    target: WarnLogger | undefined,
    private readonly fallback: () => WarnLogger,
  ) {
    this.#target = target;
  }

  /**
   * Sends held and future warnings to `logger`, unless a logger was already set. Every held
   * warning is delivered even if `logger.warn` throws; the first error is rethrown afterwards.
   */
  attach(logger: WarnLogger): void {
    if (this.#target !== undefined) return;
    this.#target = logger;
    let failure: { error: unknown } | undefined;
    for (const message of this.#pending.splice(0)) {
      try {
        logger.warn(message);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  /** Called when the object is first used: nobody attached a logger, so use the fallback. */
  use(): void {
    if (this.#target === undefined) this.attach(this.fallback());
  }

  warn(message: string): void {
    if (this.#target === undefined) this.#pending.push(message);
    else this.#target.warn(message);
  }
}

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
      // Logging must never throw into the caller (for example, a request's error handler). The
      // fallback still redacts: a non-string message (from untyped code) can hold credentials.
      return [`[${this.prefix}] ${fallbackMessage(message)}`, '[unloggable arguments]'];
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

function fallbackMessage(message: unknown): string {
  try {
    return escapeControl(redactCredentials(String(message)));
  } catch {
    return '[unloggable message]';
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
