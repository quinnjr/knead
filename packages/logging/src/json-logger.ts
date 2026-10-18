import {
  errorText,
  isPlainObject,
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
   * debug and info, stderr for warn and error. A thrown error or a rejected promise is ignored.
   */
  write?: (line: string, level: LogLevel) => unknown;
  /** The clock for the `time` field. Default: `() => new Date()`. */
  now?: () => Date;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Keys the logger sets; fields and meta never set them. */
const RESERVED = new Set(['time', 'level', 'logger', 'msg', 'err', 'meta']);
/** Keys dropped everywhere, so a parsed record cannot pollute a prototype downstream. */
const DROPPED = new Set(['__proto__', 'constructor', 'prototype']);
/** How deep values are copied: core's redactValue replaces anything deeper with `[Object]`. */
const MAX_DEPTH = 4;
/** Most array items, Set items, Map entries and object keys copied per collection. */
const MAX_ITEMS = 1000;
/** Most values copied per record, so shared references cannot make the work explode. */
const MAX_NODES = 10_000;
/** Most errors of a cause chain written in development. */
const MAX_CAUSES = 16;
/** Most errors written in detail per record in development; later ones are summarized. */
const MAX_ERRORS = 100;
const UNREADABLE = '[unreadable]';
const TRUNCATED = '[Truncated]';
/** Error properties already part of its text. */
const ERROR_TEXT_KEYS = new Set(['name', 'message', 'stack', 'cause']);

/** U+2028 and U+2029, which JSON.stringify leaves unescaped but some readers split lines on. */
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/** An Error, including one from another realm. */
function isError(value: unknown): value is Error {
  const check = (Error as { isError?: (v: unknown) => boolean }).isError;
  return check ? check(value) : value instanceof Error;
}

/** A plain object usable as fields: no `toJSON`, which would replace the object when written. */
function isFieldsObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.toJSON !== 'function';
}

/** Streams the default sink has made safe to write to. */
const guarded = new WeakSet<NodeJS.WriteStream>();

/**
 * Writes to stdout or stderr. A write error such as EPIPE (the reading end of a pipe closed) is
 * emitted asynchronously as a stream 'error' event, which would crash the process with no
 * listener, so the first write adds one that ignores it: a lost log line never stops the app.
 */
function writeDefault(line: string, level: LogLevel): void {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  if (!guarded.has(stream)) {
    guarded.add(stream);
    stream.on('error', () => {});
  }
  stream.write(`${line}\n`);
}

/** Throws a LoggingConfigError for an invalid option; called by JsonLogger and LoggingModule. */
export function validateJsonLoggerOptions(options: JsonLoggerOptions): void {
  const { level, name, fields, development, write, now } = options;
  if (level !== undefined && !Object.hasOwn(LEVELS, level)) {
    throw new LoggingConfigError(
      `JsonLogger level must be one of ${Object.keys(LEVELS).join(', ')}, got ${String(level)}`,
    );
  }
  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    throw new LoggingConfigError('JsonLogger name must be a non-empty string');
  }
  if (fields !== undefined && !isFieldsObject(fields)) {
    throw new LoggingConfigError('JsonLogger fields must be a plain object without toJSON');
  }
  if (development !== undefined && typeof development !== 'boolean') {
    throw new LoggingConfigError(
      `JsonLogger development must be a boolean, got ${typeof development}`,
    );
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
  readonly write: (line: string, level: LogLevel) => unknown;
  readonly now: () => Date;
}

/**
 * The state of one copy: the objects (and errors) on the current path, the values left to copy
 * and the errors left to write in detail.
 */
interface Walk {
  readonly seen: WeakSet<object>;
  nodes: number;
  errors: number;
}

const walk = (): Walk => ({ seen: new WeakSet(), nodes: MAX_NODES, errors: MAX_ERRORS });

/** Lets child() hand its settings to a new JsonLogger; not exported, so options cannot forge it. */
const INHERIT = Symbol('JsonLogger.inherit');

interface Inheritable {
  [INHERIT]?: { settings: Settings; fields: [string, unknown][] };
}

/**
 * Writes each entry as one line of JSON (NDJSON): `time`, `level`, `logger` and `msg` first, then
 * the logger's fields, then the entry's meta. Plain-object meta is merged in as fields (later
 * ones win); the first Error is `err`; anything else is collected in a `meta` array. Fields and
 * meta cannot set `time`, `level`, `logger`, `msg`, `err` or `meta`, and `__proto__`,
 * `constructor` and `prototype` keys are dropped.
 *
 * Everything is redacted with @knead-js/core's rules: the message, strings and object keys
 * through redactCredentials, objects through redactValue (sensitive keys such as
 * `authorization` and `password` become `***`). Errors are `Name: message` (summarizeError)
 * outside development and their redacted text, own properties and cause chain in development,
 * wherever they appear. Class instances are written as their own enumerable properties (after
 * `toJSON()` when they have one), Maps and Headers as objects, Sets as arrays, bigints as
 * strings and cycles (including an error inside itself or its own cause chain) as `[Circular]`.
 * Copies stop at 4 levels, 1000 items per collection and 10000 values per record, and a record
 * writes at most 100 errors in detail (later ones are summarized), so the work stays linear. JSON escaping keeps every record on one
 * line, so logged values cannot forge records. Logging never throws.
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
    this.#fields = this.#entries(options.fields ?? {}, walk());
  }

  /** A logger writing the same way, with `fields` added to (or replacing) this one's fields. */
  child(fields: Readonly<Record<string, unknown>>): JsonLogger {
    if (!isFieldsObject(fields)) {
      throw new LoggingConfigError(
        'JsonLogger child() fields must be a plain object without toJSON',
      );
    }
    const merged = new Map([...this.#fields, ...this.#entries(fields, walk())]);
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
  #entries(value: object, state: Walk): [string, unknown][] {
    const redacted = redactValue(this.#copy(value, 0, state));
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
      const result = settings.write(line, level);
      if (typeof (result as PromiseLike<unknown> | null | undefined)?.then === 'function') {
        Promise.resolve(result).catch(() => {});
      }
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

  /** The record written when the clock or the message could not be read. */
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
    const state = walk();
    const rest: unknown[] = [];
    let err: string | undefined;
    for (const item of meta) {
      try {
        if (isError(item) && err === undefined) {
          err = this.#error(item, 0, state);
        } else if (isFieldsObject(item)) {
          for (const [key, value] of this.#entries(item, state)) record[key] = value;
        } else {
          rest.push(redactValue(this.#copy(item, 0, state)));
        }
      } catch {
        rest.push(UNREADABLE);
      }
    }
    if (err !== undefined) record.err = err;
    if (rest.length > 0) record.meta = rest;
    return stringify(record);
  }

  /**
   * An Error found `depth` levels below a meta argument, as a string: `Name: message` outside
   * development (and once the record's detailed-error budget is spent), its redacted details in it.
   */
  #error(error: Error, depth: number, state: Walk): string {
    if (!this.#settings.development || state.errors <= 0) return summarizeError(error);
    state.errors--;
    try {
      return this.#errorDetail(error, depth, state);
    } catch {
      return summarizeError(error);
    }
  }

  /**
   * The error's redacted text and own properties, then each cause's (`Caused by: ...`), up to 16
   * errors. Built here rather than with Bun.inspect, so nothing unredacted is ever printed. Every
   * error of the chain stays on the walk's path while it is written, so an error reached again
   * through its own properties or causes is `[Circular]`, and properties are copied one level
   * below the error, so nested errors use up the same depth limit as any other value.
   */
  #errorDetail(error: Error, depth: number, state: Walk): string {
    const parts: string[] = [];
    const path: object[] = [];
    let current: unknown = error;
    let count = 0;
    try {
      for (; current !== undefined && count < MAX_CAUSES; count++) {
        const prefix = count === 0 ? '' : 'Caused by: ';
        if (typeof current === 'object' && current !== null && state.seen.has(current)) {
          parts.push(`${prefix}[Circular]`);
          current = undefined;
          break;
        }
        if (!isError(current)) {
          const copy = this.#copy(current, depth + 1, state);
          parts.push(`${prefix}${JSON.stringify(redactValue(copy))}`);
          current = undefined;
          break;
        }
        state.seen.add(current);
        path.push(current);
        parts.push(`${prefix}${redactCredentials(errorText(current))}`);
        const props = this.#errorProps(current, depth, state);
        if (props !== undefined) parts.push(`  ${JSON.stringify(props)}`);
        current = current.cause;
      }
    } finally {
      for (const item of path) state.seen.delete(item);
    }
    if (current !== undefined) parts.push('Caused by: … (more causes omitted)');
    return parts.join('\n');
  }

  /** An Error's own enumerable properties (and AggregateError's `errors`), copied and redacted. */
  #errorProps(error: Error, depth: number, state: Walk): unknown {
    const props: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key of Object.keys(error)) {
      if (ERROR_TEXT_KEYS.has(key) || DROPPED.has(key)) continue;
      props[key] = this.#read(error, key);
      count++;
    }
    if (error instanceof AggregateError && !Object.hasOwn(props, 'errors')) {
      props.errors = error.errors;
      count++;
    }
    return count === 0 ? undefined : redactValue(this.#copy(props, depth + 1, state));
  }

  #read(value: object, key: string): unknown {
    try {
      return (value as Record<string, unknown>)[key];
    } catch {
      return UNREADABLE;
    }
  }

  /** `value` as plain JSON data: no class instances, Errors, bigints, cycles or getters left. */
  #copy(value: unknown, depth: number, state: Walk): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object' || value === null) return value;
    if (state.nodes <= 0) return TRUNCATED;
    state.nodes--;
    if (state.seen.has(value)) return '[Circular]';
    if (isError(value)) return this.#error(value, depth, state);
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
    state.seen.add(value);
    try {
      return this.#copyObject(value, depth, state);
    } catch {
      return UNREADABLE;
    } finally {
      state.seen.delete(value);
    }
  }

  #copyObject(value: object, depth: number, state: Walk): unknown {
    const next = (item: unknown) => this.#copy(item, depth + 1, state);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const length = Math.min(value.length, MAX_ITEMS);
      for (let i = 0; i < length; i++) out.push(next(this.#read(value, String(i))));
      if (value.length > MAX_ITEMS) out.push(`[${value.length - MAX_ITEMS} more items]`);
      return out;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `[${value.constructor.name} ${value.byteLength} bytes]`;
    }
    if (value instanceof Set) {
      const out: unknown[] = [];
      for (const item of value) {
        if (out.length >= MAX_ITEMS) break;
        out.push(next(item));
      }
      if (value.size > MAX_ITEMS) out.push(`[${value.size - MAX_ITEMS} more items]`);
      return out;
    }
    if (value instanceof Map || value instanceof Headers) {
      const out: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const [key, item] of value.entries()) {
        if (count++ >= MAX_ITEMS) {
          out['…'] = 'more entries omitted';
          break;
        }
        const name = redactCredentials(String(key));
        if (!DROPPED.has(name)) out[name] = next(item);
      }
      return out;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      const json = toJSON.call(value);
      return json === value ? UNREADABLE : this.#copy(json, depth, state);
    }
    const out: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    const length = Math.min(keys.length, MAX_ITEMS);
    for (let i = 0; i < length; i++) {
      const key = keys[i]!;
      if (DROPPED.has(key)) continue;
      out[redactCredentials(key)] = next(this.#read(value, key));
    }
    if (keys.length > MAX_ITEMS) out['…'] = `${keys.length - MAX_ITEMS} more keys omitted`;
    return out;
  }
}

/** A Logger that adds `fields` to every entry of another Logger, as a leading meta object. */
class FieldsLogger implements Logger {
  constructor(
    readonly base: Logger,
    readonly fields: Readonly<Record<string, unknown>>,
  ) {}

  debug(message: string, ...meta: unknown[]): void {
    this.base.debug(message, this.fields, ...meta);
  }
  info(message: string, ...meta: unknown[]): void {
    this.base.info(message, this.fields, ...meta);
  }
  warn(message: string, ...meta: unknown[]): void {
    this.base.warn(message, this.fields, ...meta);
  }
  error(message: string, ...meta: unknown[]): void {
    this.base.error(message, this.fields, ...meta);
  }
}

/**
 * `fields` as FieldsLogger passes them: redacted (redactValue), without the reserved keys or
 * `__proto__`, `constructor` and `prototype`, like the fields of a JsonLogger.
 */
function redactedFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted = redactValue({ ...fields });
  if (!isPlainObject(redacted)) return {};
  return Object.fromEntries(
    Object.keys(redacted)
      .filter((key) => !RESERVED.has(key) && !DROPPED.has(key))
      .map((key) => [key, redacted[key]]),
  );
}

/**
 * A logger adding `fields` to every entry of `logger`, whatever LOGGER is configured: a
 * JsonLogger's child(), or for any other Logger (a MemoryLogger in tests, a ConsoleLogger) a
 * wrapper passing the fields as the first meta argument. Either way the fields are redacted once,
 * here, and cannot set the reserved keys.
 */
export function childLogger(logger: Logger, fields: Readonly<Record<string, unknown>>): Logger {
  if (!isFieldsObject(fields)) {
    throw new LoggingConfigError('childLogger() fields must be a plain object without toJSON');
  }
  if (logger instanceof JsonLogger) return logger.child(fields);
  if (logger instanceof FieldsLogger) {
    return new FieldsLogger(logger.base, { ...logger.fields, ...redactedFields(fields) });
  }
  return new FieldsLogger(logger, redactedFields(fields));
}
