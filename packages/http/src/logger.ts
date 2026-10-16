import { InjectionToken } from '@hpmws/core';

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const LOGGER = new InjectionToken<Logger>('LOGGER');

/**
 * `scheme://` and up to 1024 characters of the URL token (whitespace, quotes and angle brackets
 * end it). The lookbehind lets a scheme start only where no scheme character precedes it, and both
 * scans are capped, so the work is linear in the input length.
 */
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s"'<>]{1,1024})/gi;
/** A token starting `host[:port]/`: an `@` after it is in the path, not in the userinfo. */
const HOST_THEN_PATH = /^[^:/@]+(?::\d*)?\//;

/**
 * Replaces URL credentials with `***`: `redis://user:pass@host` becomes `redis://***@host`. The
 * userinfo runs to the LAST `@` within the first 1024 characters of the URL, since passwords
 * often contain unencoded `@` or `/`, unless the URL starts with `host[:port]/` (then the `@` is
 * in its path). Passwords with spaces or quotes cannot appear unencoded in a valid
 * URL and are not recognized; neither is userinfo longer than 1024 characters.
 */
export function redactCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, (match, scheme: string, rest: string) => {
    const at = rest.lastIndexOf('@');
    if (at < 0 || HOST_THEN_PATH.test(rest)) return match;
    return `${scheme}***${rest.slice(at)}`;
  });
}

/** The error's own text: its stack (which starts with `Name: message`), or `Name: message`. */
function errorText(error: Error): string {
  return error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}`;
}

function containsCredentials(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8) return false;
  const text = errorText(error);
  if (redactCredentials(text) !== text) return true;
  return containsCredentials(error.cause, depth + 1);
}

/**
 * An Error whose text holds credentials is printed as its redacted stack text, followed by its
 * redacted cause chain (a copied Error would print the copy's frames, not the original's).
 */
function redactError(error: Error): Error | string {
  if (!containsCredentials(error)) return error;
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth <= 8; depth++) {
    const text =
      current instanceof Error ? errorText(current) : typeof current === 'string' ? current : '';
    parts.push(`${depth === 0 ? '' : 'Caused by: '}${redactCredentials(text || String(current))}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join('\n');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (value instanceof Error) return redactError(value);
  return value;
}

/**
 * Logs to the console. URL credentials (`scheme://user:pass@`) in the message, in string meta and
 * in Error messages, stacks and causes are printed as `scheme://***@`; the originals are not
 * modified. An Error that needed redacting is printed as its redacted stack and cause chain.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = 'hpmws') {}

  debug(message: string, ...meta: unknown[]): void {
    console.debug(...this.#format(message, meta));
  }
  info(message: string, ...meta: unknown[]): void {
    console.info(...this.#format(message, meta));
  }
  warn(message: string, ...meta: unknown[]): void {
    console.warn(...this.#format(message, meta));
  }
  error(message: string, ...meta: unknown[]): void {
    console.error(...this.#format(message, meta));
  }

  #format(message: string, meta: unknown[]): unknown[] {
    return [`[${this.prefix}] ${redactCredentials(message)}`, ...meta.map(redactValue)];
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  meta: unknown[];
}

/** Records log entries in memory; useful in tests. */
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
