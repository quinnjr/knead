import {
  KneadError,
  type Logger,
  type LogLevel,
  redactCredentials,
  redactValue,
  summarizeError,
} from '@knead-js/core';

export class LoggingConfigError extends KneadError {}

export interface JsonLoggerOptions {
  /** The lowest level written. Default: `'debug'` in development, `'info'` otherwise. */
  level?: LogLevel;
  /** The `logger` field of every record. Default: `'knead'`. */
  name?: string;
  /** Fields added to every record (redacted once, when the logger is created). */
  fields?: Readonly<Record<string, unknown>>;
  /**
   * Whether Errors are written in full (stack, cause chain and own properties, redacted) rather
   * than as `Name: message`. Default: `NODE_ENV === 'development'`. LoggingModule passes the
   * application's DEVELOPMENT flag.
   */
  development?: boolean;
  /**
   * Receives each record as one line of JSON, without the trailing newline. Default: stdout for
   * debug and info, stderr for warn and error.
   */
  write?: (line: string, level: LogLevel) => void;
  /** The clock for the `time` field. Default: `() => new Date()`. */
  now?: () => Date;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Keys every record starts with; fields and meta never overwrite them. */
const RESERVED = new Set(['time', 'level', 'logger', 'msg']);
/** How deep values are copied before redaction (redactValue then applies its own limit). */
const MAX_DEPTH = 8;
const UNREADABLE = '[unreadable]';

/** U+2028 and U+2029, which JSON.stringify leaves unescaped but some readers split lines on. */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function writeDefault(line: string, level: LogLevel): void {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/** Throws a LoggingConfigError for an invalid option; called by JsonLogger and LoggingModule. */
export function validateJsonLoggerOptions(options: JsonLoggerOptions): void {
  const { level, name, fields, write, now } = options;
  if (level !== undefined && !Object.hasOwn(LEVELS, level)) {
    throw new LoggingConfigError(
      `JsonLogger level must be one of ${Object.keys(LEVELS).join(', ')}, got ${String(level)}`,
    );
  }
  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    throw new LoggingConfigError('JsonLogger name must be a non-empty string');
  }
  if (fields !== undefined && !isPlainObject(fields)) {
    throw new LoggingConfigError('JsonLogger fields must be a plain object');
  }
  if (write !== undefined && typeof write !== 'function') {
    throw new LoggingConfigError('JsonLogger write must be a function');
  }
  if (now !== undefined && typeof now !== 'function') {
    throw new LoggingConfigError('JsonLogger now must be a function');
  }
}

/** One line of JSON, with U+2028 and U+2029 escaped too. */
function stringify(record: Record<string, unknown>): string {
  return JSON.stringify(record).replace(LINE_SEPARATORS, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

interface Settings {
  readonly threshold: number;
  readonly name: string;
  readonly development: boolean;
  readonly write: (line: string, level: LogLevel) => void;
  readonly now: () => Date;
}

/** Lets child() hand its settings to a new JsonLogger; not exported, so options cannot forge it. */
const INHERIT = Symbol('JsonLogger.inherit');

interface Inheritable {
  [INHERIT]?: { settings: Settings; fields: [string, unknown][] };
}

/**
 * Writes each entry as one line of JSON (NDJSON): `time`, `level`, `logger` and `msg` first, then
 * the logger's fields, then the entry's meta. Plain-object meta is merged in as fields (later
 * ones win); the first Error is `err`; anything else is collected in a `meta` array.
 *
 * Everything is redacted with @knead-js/core's rules: the message and strings through
 * redactCredentials, objects through redactValue (sensitive keys such as `authorization` and
 * `password` become `***`). Errors are `Name: message` (summarizeError) outside development and
 * their full redacted text in development, wherever they appear. Class instances are written as
 * their own enumerable properties (after `toJSON()` when they have one), Maps and Headers as
 * objects, Sets as arrays, bigints as strings and cycles as `[Circular]`. JSON escaping keeps
 * every record on one line, so logged values cannot forge records. Logging never throws.
 */
export class JsonLogger implements Logger {
  readonly #settings: Settings;
  readonly #fields: readonly (readonly [string, unknown])[];

  constructor(options: JsonLoggerOptions = {}) {
    const inherited = (options as Inheritable)[INHERIT];
    if (inherited !== undefined) {
      this.#settings = inherited.settings;
      this.#fields = inherited.fields;
      return;
    }
    validateJsonLoggerOptions(options);
    const development = options.development ?? process.env.NODE_ENV === 'development';
    this.#settings = {
      threshold: LEVELS[options.level ?? (development ? 'debug' : 'info')],
      name: options.name ?? 'knead',
      development,
      write: options.write ?? writeDefault,
      now: options.now ?? (() => new Date()),
    };
    this.#fields = this.#entries(options.fields ?? {});
  }

  /** A logger writing the same way, with `fields` added to (or replacing) this one's fields. */
  child(fields: Readonly<Record<string, unknown>>): JsonLogger {
    if (!isPlainObject(fields)) {
      throw new LoggingConfigError('JsonLogger child() fields must be a plain object');
    }
    const merged = new Map([...this.#fields, ...this.#entries(fields)]);
    const inherit: Inheritable = { [INHERIT]: { settings: this.#settings, fields: [...merged] } };
    return new JsonLogger(inherit as JsonLoggerOptions);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.#log('debug', message, meta);
  }
  info(message: string, ...meta: unknown[]): void {
    this.#log('info', message, meta);
  }
  warn(message: string, ...meta: unknown[]): void {
    this.#log('warn', message, meta);
  }
  error(message: string, ...meta: unknown[]): void {
    this.#log('error', message, meta);
  }

  /** A plain object's entries, copied and redacted, without the reserved keys. */
  #entries(value: object): [string, unknown][] {
    const redacted = redactValue(this.#copy(value, 0, new WeakSet()));
    if (!isPlainObject(redacted)) return [];
    return Object.keys(redacted)
      .filter((key) => !RESERVED.has(key))
      .map((key) => [key, redacted[key]]);
  }

  #log(level: LogLevel, message: string, meta: unknown[]): void {
    const settings = this.#settings;
    if (LEVELS[level] < settings.threshold) return;
    try {
      let line: string;
      try {
        line = this.#serialize(level, message, meta);
      } catch {
        line = this.#fallback(level, message);
      }
      settings.write(line, level);
    } catch {
      // A failing sink must not surface to the caller (for example, a request's error handler).
    }
  }

  #record(level: LogLevel, time: string, msg: string): Record<string, unknown> {
    const record: Record<string, unknown> = Object.create(null);
    record.time = time;
    record.level = level;
    record.logger = this.#settings.name;
    record.msg = msg;
    for (const [key, value] of this.#fields) record[key] = value;
    return record;
  }

  /** The record written when the clock, the message or the meta could not be read. */
  #fallback(level: LogLevel, message: string): string {
    let msg: string;
    try {
      msg = redactCredentials(String(message));
    } catch {
      msg = '[unloggable message]';
    }
    const record = this.#record(level, new Date().toISOString(), msg);
    record.meta = '[unloggable meta]';
    return stringify(record);
  }

  #serialize(level: LogLevel, message: string, meta: unknown[]): string {
    const time = this.#settings.now().toISOString();
    const record = this.#record(level, time, redactCredentials(String(message)));
    const rest: unknown[] = [];
    for (const item of meta) {
      if (item instanceof Error && !Object.hasOwn(record, 'err')) {
        record.err = this.#error(item);
      } else if (isPlainObject(item) && typeof item.toJSON !== 'function') {
        for (const [key, value] of this.#entries(item)) record[key] = value;
      } else {
        rest.push(redactValue(this.#copy(item, 0, new WeakSet())));
      }
    }
    if (rest.length > 0) record.meta = rest;
    return stringify(record);
  }

  /** An Error as a string: `Name: message` outside development, its full redacted text in it. */
  #error(error: Error): string {
    if (!this.#settings.development) return summarizeError(error);
    const redacted = redactValue(error);
    // redactValue returns the Error itself when nothing in it needed redacting.
    return typeof redacted === 'string' ? redacted : Bun.inspect(error);
  }

  /** `value` as plain JSON data: no class instances, Errors, bigints, cycles or getters left. */
  #copy(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object' || value === null) return value;
    if (value instanceof Error) return this.#error(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
    seen.add(value);
    try {
      return this.#copyObject(value, depth, seen);
    } catch {
      return UNREADABLE;
    } finally {
      seen.delete(value);
    }
  }

  #copyObject(value: object, depth: number, seen: WeakSet<object>): unknown {
    const next = (item: unknown) => this.#copy(item, depth + 1, seen);
    if (Array.isArray(value)) return value.map(next);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `[${value.constructor.name} ${value.byteLength} bytes]`;
    }
    if (value instanceof Set) return [...value].map(next);
    if (value instanceof Map || value instanceof Headers) {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of value.entries()) out[String(key)] = next(item);
      return out;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      const json = toJSON.call(value);
      return json === value ? UNREADABLE : this.#copy(json, depth, seen);
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        item = UNREADABLE;
      }
      out[key] = next(item);
    }
    return out;
  }
}
