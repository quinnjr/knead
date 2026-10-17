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
 * Keys sensitive as a whole (not as a word inside a longer key, so `compass` and
 * `SharedAccessKeyName` stay readable), once lowercased and stripped of `-` and `_`.
 */
const SECRET_EXACT_KEYS = new Set([
  'pass',
  'passphrase',
  'jwt',
  'sig',
  'accesskey',
  'sharedaccesskey',
]);
/**
 * Words that make any key containing them sensitive, once lowercased and stripped of `-` and `_`
 * (`db_password`, `x-api-key`, `clientSecret`, `AWS_SECRET_ACCESS_KEY`, `sessionId`). Such object
 * keys keep number and boolean values (`maxTokens: 100`); every other value becomes `***`.
 */
const SENSITIVE_WORDS =
  /password|passwd|pwd|secret|token|apikey|accountkey|privatekey|connectionstring|authorization|cookie|credential|sessionid/;

/** `key` lowercased, without `-` and `_`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * `'exact'` for a SENSITIVE_KEYS or SECRET_EXACT_KEYS key, `'word'` for one containing a
 * SENSITIVE_WORDS word.
 */
function sensitivity(key: string): 'exact' | 'word' | undefined {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return 'exact';
  // Keys longer than this are not names; skip the scan rather than test arbitrary text.
  if (lower.length > 128) return undefined;
  const normalized = normalizeKey(lower);
  if (SECRET_EXACT_KEYS.has(normalized)) return 'exact';
  return SENSITIVE_WORDS.test(normalized) ? 'word' : undefined;
}

/** Whether the value of a `key=value` or `key: value` pair in text is a credential. */
function isSecretKey(key: string): boolean {
  return sensitivity(key) !== undefined;
}

/** Longest key looked at before an `=` or `:`, in characters. */
const MAX_KEY_LENGTH = 64;
/** Most blanks skipped between a key and its `:`, and before a `key:` to find the line start. */
const MAX_BLANKS = 64;

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

/** A space or a tab. */
function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/** `&`, `;` and whitespace end a `key=value` value. */
const VALUE_END = /[&;\s]/g;
/** `&`, `;`, whitespace, `,`, `}` and `]` end an unquoted `key: value` value. */
const COLON_VALUE_END = /[&;\s,}\]]/g;
/** A line break ends the value of an Authorization or Cookie header line. */
const LINE_END = /[\r\n]/g;
/** The scheme of an Authorization header value (`Bearer`, `Token`, ...), kept readable. */
const AUTH_SCHEME_PREFIX = /[A-Za-z][A-Za-z0-9._-]*[ \t]+(?=[^\s])/y;
/** Header names whose `name: value` line value is a credential whatever its shape. */
const HEADER_KEYS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/**
 * The index of the quote closing a value opened by `quote` just before `from`, honouring
 * backslash escapes, or -1. `noClose` holds, per quote, a position after which no closing quote
 * exists (a scan from there failed, and a value never opens on an escaped quote), so repeated
 * unterminated values are not rescanned and the work stays linear.
 */
function closingQuote(
  text: string,
  from: number,
  quote: number,
  noClose: Map<number, number>,
): number {
  if (from >= (noClose.get(quote) ?? text.length + 1)) return -1;
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) i++;
    else if (code === quote) return i;
  }
  noClose.set(quote, from);
  return -1;
}

/** The quote (`"` or `'`) at `index`, or 0. */
function quoteAt(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code === 0x22 || code === 0x27 ? code : 0;
}

/**
 * Redacts the values of `key=value` and `key: value` pairs whose key is secret (see
 * isSecretKey), case-insensitive and with any prefix or suffix (`access_token=`,
 * `client_secret=`, `DB_PASSWORD=`, `x-api-key=`, `{"password":"x"}`, `password: x`). A quoted
 * value runs to its closing quote (`password="hunter 2"`); the value of an `Authorization:` or
 * `Cookie:` line runs to the end of the line, keeping an Authorization scheme. An unquoted
 * `key:` counts only at the start of a line or after `{` or `,` (YAML, header lines, inspected
 * objects), so prose such as "Invalid token: expired" stays readable. Every separator is found
 * with indexOf and its key read backwards (at most 64 characters), so the work is linear.
 */
function redactSecretPairs(text: string): string {
  let out = '';
  let copied = 0;
  const noClose = new Map<number, number>();
  let nextEq = text.indexOf('=');
  let nextColon = text.indexOf(':');
  let from = 0;
  for (;;) {
    if (nextEq !== -1 && nextEq < from) nextEq = text.indexOf('=', from);
    if (nextColon !== -1 && nextColon < from) nextColon = text.indexOf(':', from);
    const sep = nextEq === -1 ? nextColon : nextColon === -1 ? nextEq : Math.min(nextEq, nextColon);
    if (sep === -1) break;
    from = sep + 1;
    const colon = sep === nextColon;
    let keyEnd = sep;
    if (colon) {
      while (keyEnd > 0 && sep - keyEnd < MAX_BLANKS && isBlank(text.charCodeAt(keyEnd - 1)))
        keyEnd--;
    }
    const keyQuote = keyEnd > 0 ? quoteAt(text, keyEnd - 1) : 0;
    if (keyQuote !== 0) keyEnd--;
    let start = keyEnd;
    while (start > 0 && keyEnd - start < MAX_KEY_LENGTH && isKeyChar(text.charCodeAt(start - 1)))
      start--;
    if (keyQuote !== 0 && (start === 0 || text.charCodeAt(start - 1) !== keyQuote)) continue;
    // The shortest secret keys ('pwd', 'jwt', 'sig') have 3 characters.
    if (keyEnd - start < 3) continue;
    const key = text.slice(start, keyEnd);
    if (!isSecretKey(key)) continue;
    let header = false;
    if (colon && keyQuote === 0) {
      let before = start;
      while (before > 0 && start - before < MAX_BLANKS && isBlank(text.charCodeAt(before - 1)))
        before--;
      const code = before === 0 ? 0x0a : text.charCodeAt(before - 1);
      if (code !== 0x0a && code !== 0x0d && code !== 0x7b && code !== 0x2c) continue;
      header = HEADER_KEYS.has(key.toLowerCase());
    }
    let value = sep + 1;
    if (colon) {
      // Each blank is skipped only after its own separator: still linear.
      while (value < text.length && isBlank(text.charCodeAt(value))) value++;
    }
    let valueStart = value;
    let end = -1;
    const quote = quoteAt(text, value);
    if (quote !== 0) {
      const close = closingQuote(text, value + 1, quote, noClose);
      if (close !== -1) {
        valueStart = value + 1;
        end = close;
      }
    }
    if (end === -1) {
      const stop = header ? LINE_END : colon ? COLON_VALUE_END : VALUE_END;
      stop.lastIndex = value;
      end = stop.exec(text)?.index ?? text.length;
      if (header && key.toLowerCase().endsWith('authorization')) {
        AUTH_SCHEME_PREFIX.lastIndex = value;
        if (AUTH_SCHEME_PREFIX.test(text) && AUTH_SCHEME_PREFIX.lastIndex < end) {
          valueStart = AUTH_SCHEME_PREFIX.lastIndex;
        }
      }
    }
    if (end > valueStart) {
      out += `${text.slice(copied, valueStart)}***`;
      copied = end;
      from = end;
    } else from = Math.max(from, value);
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

/** `[A-Za-z]`. */
function isLetter(code: number): boolean {
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x7a;
}

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
 * characters before it (its last 32 at most), from its first letter. Each step is bounded, so the
 * work is linear in the input length.
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
    while (b > 0 && i - b < MAX_SCHEME && isSchemeChar(text.charCodeAt(b - 1))) b--;
    // A scheme starts with a letter: `-redis://` and `1redis://` are `redis://`, and a longer
    // run keeps its last 32 characters.
    while (b < i && !isLetter(text.charCodeAt(b))) b++;
    const length = i - b;
    if (length >= 1) {
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
 * `redis://***@host`); values of `key=value` pairs (query strings, connection strings, env
 * dumps) and of `"key":"value"` / `key: value` pairs (JSON, YAML, header lines) whose key is
 * sensitive as for redactValue (a word such as password, secret, token, apikey, credential or
 * sessionid in any case, with any prefix, suffix or `-`/`_` separators, or exactly pass,
 * passphrase, jwt, sig, AccessKey or SharedAccessKey), a quoted value up to its closing quote;
 * `Authorization:` and `Cookie:` line values whatever their scheme; and `Bearer`/`Basic`
 * credentials in any case. The userinfo runs to the LAST `@` within the first 1024
 * characters of the URL, since passwords often contain unencoded `@` or `/`. Only http(s) URLs
 * starting `host[:port]/` are exempt (an `@` there is in the path), and credential URLs nested
 * inside them are still redacted. Passwords with spaces or quotes cannot appear unencoded in a
 * valid URL and are not recognized; neither is userinfo longer than 1024 characters. The work is
 * linear in the input length.
 */
export function redactCredentials(text: string): string {
  let out = redactUrls(text);
  if (out.includes('=') || out.includes(':')) out = redactSecretPairs(out);
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
  /** Strings and objects walked so far (see MAX_NODES). */
  nodes: number;
}

/** Most strings and objects one redactValue() call walks; the rest become `[Truncated]`. */
const MAX_NODES = 20_000;
const TRUNCATED = '[Truncated]';

function ownProps(
  error: Error,
  state: Walk = { changed: false, seen: new WeakSet(), nodes: 0 },
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

/**
 * Walks `view` in place of `value` (a class instance shown as its href, entries or fields) and
 * returns the walked view only when something in it was redacted, else `value` itself.
 */
function walkAs(value: object, view: unknown, depth: number, state: Walk): unknown {
  const outer = state.changed;
  state.changed = false;
  state.seen.add(value);
  try {
    const walked = walk(view, depth, state);
    const changed = state.changed;
    state.changed = outer || changed;
    return changed ? walked : value;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * What a class instance is walked as: a URL as its href, a Request or Response as its method or
 * status, url and headers, a map-like object (see isMapLike) as its entries or its `toJSON()`
 * string; `undefined` for any other instance, which is walked as its own properties.
 */
function viewOf(value: object): unknown {
  if (value instanceof Request) {
    return { method: value.method, url: value.url, headers: value.headers };
  }
  if (value instanceof Response) {
    return { status: value.status, url: value.url, headers: value.headers };
  }
  if (!isMapLike(value)) return undefined;
  const candidate = value as { entries?: unknown; toJSON?: unknown };
  if (typeof candidate.entries !== 'function') {
    const json = (candidate.toJSON as () => unknown).call(value);
    if (typeof json === 'string') return json;
  }
  return entriesOf(value);
}

function walk(value: unknown, depth: number, state: Walk): unknown {
  if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return value;
  // Shared references are walked once per path: bound the total work on wide graphs.
  if (++state.nodes > MAX_NODES) {
    state.changed = true;
    return TRUNCATED;
  }
  if (typeof value === 'string') {
    const redacted = redactCredentials(value);
    if (redacted !== value) state.changed = true;
    return redacted;
  }
  const isError = value instanceof Error;
  if (!isError && !Array.isArray(value) && !isPlainObject(value)) {
    // Class instances: walked as a view (see viewOf) or as their own properties, and replaced
    // only when something in them was redacted. Like plain objects, one in a cycle or past the
    // depth limit is replaced, so its unwalked contents (a nested Authorization header) never
    // reach the log; dates, binary data and instances without own properties are kept.
    let view: unknown;
    try {
      if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return value;
      }
      if (state.seen.has(value)) {
        state.changed = true;
        return '[Circular]';
      }
      // A URL is a string: its userinfo is redacted at any depth.
      if (value instanceof URL) return walkAs(value, value.href, depth, state);
      if (depth >= REDACT_DEPTH) {
        const viewed = value instanceof Request || value instanceof Response || isMapLike(value);
        if (!viewed && readProps(value, state).length === 0) return value;
        state.changed = true;
        return '[Object]';
      }
      view = viewOf(value);
    } catch {
      state.changed = true;
      return UNREADABLE;
    }
    if (view !== undefined) return walkAs(value, view, depth, state);
  } else {
    if (state.seen.has(value)) {
      state.changed = true;
      return '[Circular]';
    }
    if (depth >= REDACT_DEPTH) {
      state.changed = true;
      return Array.isArray(value) ? '[Array]' : '[Object]';
    }
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, state));
    // An Error or class instance tracks its own changes: it is replaced only when something in
    // it was redacted.
    const local = isError || !isPlainObject(value);
    const outer = state.changed;
    if (local) state.changed = false;
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
    if (!local) return out;
    if (!isError) {
      const changed = state.changed;
      state.changed = outer || changed;
      return changed ? out : value;
    }
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
 * to 4 levels deep, with the values of sensitive keys (`authorization`, `cookie`, `password`, `pass`,
 * `jwt`, `sig`, `token`, `apikey`, ..., and any key containing such a word whatever its case or separators,
 * such as `db_password` or `x-api-key`) replaced by `***`, credentials in keys redacted too;
 * a URL is walked as its href (and becomes that redacted string when it held credentials); a
 * Request or Response as its method or status, url and headers; Headers, Maps and other objects
 * with `entries()` or `toJSON()` as their entries (or as the string `toJSON()` returns); other
 * class instances as their own enumerable properties, into a copy with the same prototype. Each
 * of these is replaced only when something in it was redacted; dates and binary data are kept.
 * Deeper values become `[Object]`/`[Array]` (an instance without own properties is kept), cycles
 * become `[Circular]`, and past 20000 strings and objects walked the rest become `[Truncated]`.
 * Causes that are not Errors are walked too. An Error that needed redacting, or whose cause chain
 * is longer than 16, becomes its redacted stack text. The original is never modified, and a
 * value with nothing to redact is returned unchanged.
 */
export function redactValue(value: unknown): unknown {
  try {
    const state: Walk = { changed: false, seen: new WeakSet(), nodes: 0 };
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
