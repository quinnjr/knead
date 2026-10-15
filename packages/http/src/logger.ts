import { InjectionToken } from '@hpmws/core';

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const LOGGER = new InjectionToken<Logger>('LOGGER');

export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = 'hpmws') {}

  debug(message: string, ...meta: unknown[]): void {
    console.debug(`[${this.prefix}] ${message}`, ...meta);
  }
  info(message: string, ...meta: unknown[]): void {
    console.info(`[${this.prefix}] ${message}`, ...meta);
  }
  warn(message: string, ...meta: unknown[]): void {
    console.warn(`[${this.prefix}] ${message}`, ...meta);
  }
  error(message: string, ...meta: unknown[]): void {
    console.error(`[${this.prefix}] ${message}`, ...meta);
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
