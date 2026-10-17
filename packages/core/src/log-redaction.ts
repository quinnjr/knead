/**
 * Redaction for log output, shared by every package that logs: credentials in URLs, Authorization
 * values and secret `key=value` pairs, sensitive object keys, and control characters.
 */

/** An http(s) URL starting `host[:port]/`: an `@` after it is in the path, not the userinfo. */
const HOST_THEN_PATH = /[^:/@\s"'<>]+(?::\d*)?\//y;
/** Longest userinfo recognized, in characters. */
const USERINFO_WINDOW = 1024;
/** Longest scheme recognized, in characters. */
const MAX_SCHEME = 32;
/** Key words that mark a `key=value` pair as secret, anywhere in the (lowercased) key. */
const SECRET_KEY = /password|passwd|pwd|secret|token|apikey|api_key|accountkey/i;
/** Longest key looked at before an `=`, in characters. */
const MAX_KEY_LENGTH = 64;

/** `[A-Za-z0-9_.-]`: the characters of a key in `key=value`. */
function isKeyChar(code: number): boolean {
  const lower = code | 0x20;
  return (
    (lower >= 0x61 && lower <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2e ||
    code === 0x2d
  );
}

/** `&`, `;` and whitespace end a value. */
const VALUE_END = /[&;\s]/g;

/**
 * Redacts the values of `key=value` pairs whose key contains a secret key word, case-insensitive
 * and with any prefix or suffix (`access_token=`, `client_secret=`, `DB_PASSWORD=`,
 * `PGPASSWORD=`). Every `=` is found with indexOf and its key read backwards (at most 64
 * characters), so the work is linear.
 */
function redactSecretPairs(text: string): string {
  let out = '';
  let copied = 0;
  for (let eq = text.indexOf('='); eq !== -1; ) {
    let start = eq;
    while (start > 0 && eq - start < MAX_KEY_LENGTH && isKeyChar(text.charCodeAt(start - 1)))
      start--;
    let next = eq + 1;
    // The shortest key word ('pwd') has 3 characters; shorter keys need no further look.
    if (eq - start >= 3 && SECRET_KEY.test(text.slice(start, eq))) {
      VALUE_END.lastIndex = eq + 1;
      const end = VALUE_END.exec(text)?.index ?? text.length;
      if (end > eq + 1) {
        out += `${text.slice(copied, eq + 1)}***`;
        copied = end;
        next = end;
      }
    }
    eq = text.indexOf('=', next);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * A credential-shaped value only (8+ token characters, or a `:`/`=` with a token character
 * right before and after it, as in `user:pass`), so prose such as "a basic mistake" or
 * "basic setup: done" stays readable. Known limit: short tokens such as `Bearer abc123` are not
 * redacted.
 */
const AUTH_SCHEMES =
  /\b(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]+[:=][A-Za-z0-9._~+/=:-]+)/gi;
const AUTH_HINT = /bearer|basic/i;

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
 * `redis://***@host`), values of `key=value` pairs (query strings, connection strings, env
 * dumps) whose key contains password/passwd/pwd/secret/token/apikey/api_key/accountkey in any
 * case and with any prefix or suffix (`access_token=`, `DB_PASSWORD=`), and `Bearer`/`Basic`
 * credentials in any case. The userinfo runs to the LAST `@` within the first 1024
 * characters of the URL, since passwords often contain unencoded `@` or `/`. Only http(s) URLs
 * starting `host[:port]/` are exempt (an `@` there is in the path), and credential URLs nested
 * inside them are still redacted. Passwords with spaces or quotes cannot appear unencoded in a
 * valid URL and are not recognized; neither is userinfo longer than 1024 characters. The work is
 * linear in the input length.
 */
export function redactCredentials(text: string): string {
  let out = redactUrls(text);
  if (out.includes('=')) out = redactSecretPairs(out);
  if (AUTH_HINT.test(out)) out = out.replace(AUTH_SCHEMES, '$1 ***');
  return out;
}

/**
 * The error's own text: its stack (which starts with `Name: message`), or `Name: message` when the
 * stack is missing, not a string, or does not hold the message.
 */
export function errorText(error: Error): string {
  const stack = error.stack;
  return typeof stack === 'string' && stack.includes(error.message)
    ? stack
    : `${error.name}: ${error.message}`;
}

/** Keys whose values are replaced with `***` wherever they appear, whatever the value. */
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
/**
 * Words that make any key containing them sensitive, once lowercased and stripped of `-` and `_`
 * (`db_password`, `x-api-key`, `clientSecret`, `AWS_SECRET_ACCESS_KEY`, `sessionId`). Such keys
 * keep number and boolean values (`maxTokens: 100`); every other value becomes `***`.
 */
const SENSITIVE_WORDS =
  /password|passwd|pwd|secret|token|apikey|accountkey|privatekey|connectionstring|authorization|cookie|credential|sessionid/;

/** `'exact'` for a SENSITIVE_KEYS key, `'word'` for one containing a SENSITIVE_WORDS word. */
function sensitivity(key: string): 'exact' | 'word' | undefined {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return 'exact';
  // Keys longer than this are not names; skip the scan rather than test arbitrary text.
  if (lower.length > 128) return undefined;
  return SENSITIVE_WORDS.test(lower.replace(/[-_]/g, '')) ? 'word' : undefined;
}

function isRedactable(item: unknown, kind: 'exact' | 'word'): boolean {
  if (item === undefined || item === null) return false;
  return (
    kind === 'exact' ||
    (typeof item !== 'number' && typeof item !== 'boolean' && typeof item !== 'bigint')
  );
}

/** Most errors of a cause chain scanned; a longer chain is never returned as the raw Error. */
const MAX_CAUSES = 16;
/** How deep redactValue walks objects, arrays and Error properties. */
const REDACT_DEPTH = 4;
/** Error properties printed as part of the error's text. */
const ERROR_TEXT_KEYS = new Set(['name', 'message', 'stack', 'cause']);

/** An object whose prototype is `Object.prototype` or `null` (a literal or `Object.create(null)`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const UNREADABLE = '[unreadable]';

/**
 * Own enumerable properties, string and Symbol keys alike, each read on its own: a throwing
 * getter becomes '[unreadable]'.
 */
function readProps(value: object, state: Walk): [PropertyKey, unknown][] {
  let keys: PropertyKey[];
  try {
    keys = [
      ...Object.keys(value),
      ...Object.getOwnPropertySymbols(value).filter((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol),
      ),
    ];
  } catch {
    state.changed = true;
    return [[UNREADABLE, UNREADABLE]];
  }
  return keys.map((key) => {
    try {
      return [key, (value as Record<PropertyKey, unknown>)[key]];
    } catch {
      state.changed = true;
      return [key, UNREADABLE];
    }
  });
}

/**
 * Whether redactValue walks `value` as its entries: Headers, Map and other objects with
 * `entries()` or `toJSON()`, except dates and binary data.
 */
function isMapLike(value: object): boolean {
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return false;
  }
  if (value instanceof Headers || value instanceof Map) return true;
  const candidate = value as { entries?: unknown; toJSON?: unknown };
  return typeof candidate.entries === 'function' || typeof candidate.toJSON === 'function';
}

/**
 * The entries of a map-like object (see isMapLike) as a plain object, or undefined when its
 * `toJSON()` returns something other than an object.
 */
function entriesOf(value: object): Record<string, unknown> | undefined {
  const candidate = value as { entries?: unknown; toJSON?: unknown };
  // Headers and Map have entries(); the rest have entries() or toJSON() (isMapLike).
  if (typeof candidate.entries === 'function') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of (candidate.entries as () => Iterable<[unknown, unknown]>).call(value))
      out[String(key)] = item;
    return out;
  }
  const json = (candidate.toJSON as () => unknown).call(value);
  return typeof json === 'object' && json !== null ? { ...(json as object) } : undefined;
}

interface Walk {
  changed: boolean;
  readonly seen: WeakSet<object>;
}

function ownProps(
  error: Error,
  state: Walk = { changed: false, seen: new WeakSet() },
): [PropertyKey, unknown][] {
  const entries = readProps(error, state).filter(
    ([key]) => typeof key !== 'string' || !ERROR_TEXT_KEYS.has(key),
  );
  // AggregateError keeps `errors` as a non-enumerable own property.
  if (error instanceof AggregateError && !entries.some(([key]) => key === 'errors')) {
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
  if (!isError && !Array.isArray(value) && !isPlainObject(value)) {
    // Headers, Map and header-like objects (err.config.headers.Authorization): walked as
    // their entries, and replaced only when something in them was redacted.
    // Like plain objects, a map-like object in a cycle or past the depth limit is replaced, so
    // its unwalked entries (a nested Authorization header) never reach the log.
    let entries: Record<string, unknown> | undefined;
    try {
      if (!isMapLike(value)) return value;
      if (state.seen.has(value)) {
        state.changed = true;
        return '[Circular]';
      }
      if (depth >= REDACT_DEPTH) {
        state.changed = true;
        return '[Object]';
      }
      entries = entriesOf(value);
    } catch {
      state.changed = true;
      return UNREADABLE;
    }
    if (entries === undefined) return value;
    const outer = state.changed;
    state.changed = false;
    state.seen.add(value);
    try {
      const walked = walk(entries, depth, state);
      const changed = state.changed;
      state.changed = outer || changed;
      return changed ? walked : value;
    } finally {
      state.seen.delete(value);
    }
  }
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
    const entries = isError ? ownProps(value, state) : readProps(value, state);
    const out: Record<PropertyKey, unknown> = isError
      ? {}
      : Object.create(Object.getPrototypeOf(value));
    for (const [rawKey, item] of entries) {
      let key = rawKey;
      if (typeof rawKey === 'string') {
        key = redactCredentials(rawKey);
        if (key !== rawKey) state.changed = true;
      }
      const kind = typeof rawKey === 'string' ? sensitivity(rawKey) : undefined;
      if (kind !== undefined && isRedactable(item, kind)) {
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
  for (let level = 0; current !== undefined && level < MAX_CAUSES; level++) {
    if (typeof current === 'object' && current !== null && !(current instanceof Error)) {
      // A non-Error cause (`{ cause: { headers } }`) is walked like any other value.
      parts.push(`Caused by: ${Bun.inspect(walk(current, depth + 1, state))}`);
      current = undefined;
      break;
    }
    const raw =
      current instanceof Error ? errorText(current) : typeof current === 'string' ? current : '';
    const text = raw || String(current);
    const redacted = redactCredentials(text);
    if (redacted !== text) state.changed = true;
    parts.push(`${level === 0 ? '' : 'Caused by: '}${redacted}`);
    if (level > 0 && current instanceof Error) {
      // ownProps includes the non-enumerable AggregateError.errors.
      const props = ownProps(current, state);
      if (props.length > 0) {
        const nested = walk(Object.fromEntries(props), depth + 1, state);
        parts.push(`  ${Bun.inspect(nested)}`);
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  if (current !== undefined) {
    // The rest of the chain was not scanned, so the raw Error must not be printed.
    parts.push('Caused by: … (more causes omitted)');
    state.changed = true;
  }
  if (!state.changed) return error;
  if (Object.keys(props).length > 0) parts.splice(1, 0, `  ${Bun.inspect(props)}`);
  return parts.join('\n');
}

/**
 * A copy of `value` with credentials redacted, for logging: strings through redactCredentials;
 * plain objects, arrays and Error own properties (including `AggregateError.errors`) walked up
 * to 4 levels deep, with the values of sensitive keys (`authorization`, `cookie`, `password`,
 * `token`, `apikey`, ..., and any key containing such a word whatever its case or separators,
 * such as `db_password` or `x-api-key`) replaced by `***`, credentials in keys redacted too;
 * Headers, Maps and other objects with `entries()` or `toJSON()` are walked as their entries;
 * deeper values become `[Object]`/`[Array]` and cycles become `[Circular]`. Causes that are not
 * Errors are walked too. An Error that needed redacting, or whose cause chain is longer
 * than 16, becomes its redacted stack text. Other objects (class instances) are returned as is.
 * The original is never modified, and a value with nothing to redact is returned unchanged.
 */
export function redactValue(value: unknown): unknown {
  try {
    const state: Walk = { changed: false, seen: new WeakSet() };
    const result = walk(value, 0, state);
    return state.changed ? result : value;
  } catch (error) {
    // A Proxy or exotic object defeated the walk: log a summary, never the value itself.
    try {
      return `[unloggable value: ${summarizeError(error)}]`;
    } catch {
      return '[unloggable value]';
    }
  }
}

/** C0 control characters (U+0000 to U+001F) and DEL, all escaped in log lines. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function escapeControl(text: string): string {
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
