import { InjectionToken } from '@hpmws/core';

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const LOGGER = new InjectionToken<Logger>('LOGGER');

/** An http(s) URL starting `host[:port]/`: an `@` after it is in the path, not the userinfo. */
const HOST_THEN_PATH = /[^:/@\s"'<>]+(?::\d*)?\//y;
/** Longest userinfo recognized, in characters. */
const USERINFO_WINDOW = 1024;
/** Longest scheme recognized, in characters. */
const MAX_SCHEME = 32;
/** `password=…`-style pairs, in query strings and key=value connection strings. */
const SECRET_PAIRS =
  /\b(password|passwd|pwd|secret|token|apikey|api_key|accountkey|sslpassword)=[^&;\s]+/gi;
/** HTTP Authorization credentials. */
const AUTH_SCHEMES = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;

/** Whitespace, quotes and angle brackets end a URL token. */
const STOP = /[\s"'<>]/g;

/** `[a-z0-9+.-]`, case-insensitive. */
function isSchemeChar(code: number): boolean {
  const lower = code | 0x20;
  return (
    (lower >= 0x61 && lower <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x2d
  );
}

/**
 * Redacts URL userinfo. Every `://` is located with indexOf; its scheme is the run of scheme
 * characters before it (1 to 32, starting with a letter). Each step is bounded, so the work is
 * linear in the input length.
 */
function redactUrls(text: string): string {
  if (!text.includes('@')) return text;
  // Each window ends at or after the previous one's end, so `lastAt` (the last '@' before the
  // current window's end) and `nextAt` only move forward.
  let lastAt = -1;
  let nextAt = text.indexOf('@');
  let out = '';
  let copied = 0;
  let stop = -1;
  for (let i = text.indexOf('://'); i !== -1; ) {
    let from = i + 1;
    let b = i;
    while (b > 0 && i - b <= MAX_SCHEME && isSchemeChar(text.charCodeAt(b - 1))) b--;
    const length = i - b;
    const first = text.charCodeAt(b) | 0x20;
    if (length >= 1 && length <= MAX_SCHEME && first >= 0x61 && first <= 0x7a) {
      const start = i + 3;
      if (stop < start) {
        STOP.lastIndex = start;
        stop = STOP.exec(text)?.index ?? text.length;
      }
      const end = Math.min(stop, start + USERINFO_WINDOW);
      if (end > start) {
        // nextAt (the first '@' at or after the scanned prefix) only moves forward.
        while (nextAt !== -1 && nextAt < end) {
          lastAt = nextAt;
          nextAt = text.indexOf('@', nextAt + 1);
        }
        const at = lastAt;
        let exempt = at < start;
        if (!exempt && length <= 5 && /^https?$/i.test(text.slice(b, i))) {
          HOST_THEN_PATH.lastIndex = start;
          // An `@` in the path is not credentials. Scanning continues inside the URL, so a
          // credential URL nested in its path or query (`?to=redis://u:p@h`) is still found.
          exempt = HOST_THEN_PATH.test(text);
        }
        if (!exempt) {
          out += `${text.slice(copied, start)}***`;
          copied = at;
          from = at + 1;
        }
      }
    }
    i = text.indexOf('://', from);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Replaces credentials with `***`: URL userinfo (`redis://user:pass@host` becomes
 * `redis://***@host`), `password=`/`pwd=`/`secret=`/`token=`/`apikey=`/`api_key=`/
 * `accountkey=`/`sslpassword=` values in query strings and key=value connection strings, and
 * `Bearer`/`Basic` credentials. The userinfo runs to the LAST `@` within the first 1024
 * characters of the URL, since passwords often contain unencoded `@` or `/`. Only http(s) URLs
 * starting `host[:port]/` are exempt (an `@` there is in the path), and credential URLs nested
 * inside them are still redacted. Passwords with spaces or quotes cannot appear unencoded in a
 * valid URL and are not recognized; neither is userinfo longer than 1024 characters. The work is
 * linear in the input length.
 */
export function redactCredentials(text: string): string {
  let out = redactUrls(text);
  if (out.includes('=')) out = out.replace(SECRET_PAIRS, '$1=***');
  if (out.includes('Bearer') || out.includes('Basic')) out = out.replace(AUTH_SCHEMES, '$1 ***');
  return out;
}

/** The error's own text: its stack (which starts with `Name: message`), or `Name: message`. */
function errorText(error: Error): string {
  return error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}`;
}

/** Keys whose values are replaced with `***` wherever they appear (case-insensitive). */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'accesstoken',
  'refreshtoken',
  'accountkey',
  'privatekey',
  'connectionstring',
]);
/** How deep redactValue walks objects, arrays and Error properties. */
const REDACT_DEPTH = 4;
/** Error properties printed as part of the error's text. */
const ERROR_TEXT_KEYS = new Set(['name', 'message', 'stack', 'cause']);

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface Walk {
  changed: boolean;
  readonly seen: WeakSet<object>;
}

function ownProps(error: Error): [string, unknown][] {
  const entries = Object.entries(error).filter(([key]) => !ERROR_TEXT_KEYS.has(key));
  // AggregateError keeps `errors` as a non-enumerable own property.
  if (error instanceof AggregateError && !Object.hasOwn(Object.fromEntries(entries), 'errors')) {
    entries.push(['errors', error.errors]);
  }
  return entries;
}

function walk(value: unknown, depth: number, state: Walk): unknown {
  if (typeof value === 'string') {
    const redacted = redactCredentials(value);
    if (redacted !== value) state.changed = true;
    return redacted;
  }
  if (typeof value !== 'object' || value === null) return value;
  const isError = value instanceof Error;
  if (!isError && !Array.isArray(value) && !isPlainObject(value)) return value;
  if (state.seen.has(value)) {
    state.changed = true;
    return '[Circular]';
  }
  if (depth >= REDACT_DEPTH) {
    state.changed = true;
    return Array.isArray(value) ? '[Array]' : '[Object]';
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, state));
    // An Error tracks its own changes: it is replaced only when something in it was redacted.
    const outer = state.changed;
    if (isError) state.changed = false;
    const entries = isError ? ownProps(value) : Object.entries(value);
    const out: Record<string, unknown> = isError ? {} : Object.create(Object.getPrototypeOf(value));
    for (const [key, item] of entries) {
      if (SENSITIVE_KEYS.has(key.toLowerCase()) && item !== undefined && item !== null) {
        out[key] = '***';
        state.changed = true;
      } else out[key] = walk(item, depth + 1, state);
    }
    if (!isError) return out;
    const result = redactError(value, out, depth, state);
    state.changed ||= outer;
    return result;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * An Error is kept as is when neither its text, its cause chain nor its own properties hold
 * anything to redact. Otherwise it is printed as its redacted stack text and `Caused by:` chain
 * (a copied Error would print the copy's frames, not the original's), followed by its redacted
 * own properties.
 */
function redactError(error: Error, props: Record<string, unknown>, depth: number, state: Walk) {
  const parts: string[] = [];
  let current: unknown = error;
  for (let level = 0; current !== undefined && level <= 8; level++) {
    const raw =
      current instanceof Error ? errorText(current) : typeof current === 'string' ? current : '';
    const text = raw || String(current);
    const redacted = redactCredentials(text);
    if (redacted !== text) state.changed = true;
    parts.push(`${level === 0 ? '' : 'Caused by: '}${redacted}`);
    if (level > 0 && current instanceof Error && Object.keys(current).length > 0) {
      const nested = walk(Object.fromEntries(ownProps(current)), depth + 1, state);
      parts.push(`  ${Bun.inspect(nested)}`);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  if (!state.changed) return error;
  if (Object.keys(props).length > 0) parts.splice(1, 0, `  ${Bun.inspect(props)}`);
  return parts.join('\n');
}

/**
 * A copy of `value` with credentials redacted, for logging: strings through redactCredentials;
 * plain objects, arrays and Error own properties (including `AggregateError.errors`) walked up
 * to 4 levels deep, with the values of sensitive keys (`authorization`, `cookie`, `password`,
 * `token`, `apikey`, ...) replaced by `***`; cycles become `[Circular]`. An Error that needed
 * redacting becomes its redacted stack text. Other objects (class instances) are returned as is.
 * The original is never modified, and a value with nothing to redact is returned unchanged.
 */
export function redactValue(value: unknown): unknown {
  const state: Walk = { changed: false, seen: new WeakSet() };
  const result = walk(value, 0, state);
  return state.changed ? result : value;
}

/** C0 control characters (U+0000 to U+001F) and DEL, all escaped in log lines. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/g;

function escapeControl(text: string): string {
  return text.replace(CONTROL, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/** Longest client-controlled value interpolated into a log message. */
export const MAX_LOGGED_VALUE_LENGTH = 1024;

/**
 * A client-controlled value (a path, a topic, an id) made safe to interpolate into a log
 * message: capped at 1024 characters and with control characters escaped (`\n`, `\x1b`), so it
 * cannot forge log lines whatever logger is configured.
 */
export function logValue(value: unknown): string {
  let text = String(value);
  if (text.length > MAX_LOGGED_VALUE_LENGTH) text = `${text.slice(0, MAX_LOGGED_VALUE_LENGTH)}…`;
  return escapeControl(text);
}

/**
 * Logs to the console. Credentials (see redactCredentials) in the message, in string meta and in
 * objects, arrays and Errors (messages, stacks, causes and own properties, see redactValue) are
 * printed redacted; the originals are not modified. Control characters (CR, LF, ESC, ...) in the
 * message and in string meta are escaped, so a logged value cannot start a forged log line.
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
