import { Injectable, inject } from '@knead-js/core';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { logError } from './error-log.js';
import {
  ForbiddenException,
  HttpConfigError,
  ServiceUnavailableException,
  TooManyRequestsException,
} from './exceptions.js';
import { LOGGER, logValue } from './logger.js';
import { isIpv6Prefix, maskIp } from './net.js';
import { joinPaths } from './path.js';
import { HTTP_DEVELOPMENT } from './tokens.js';
import type { Ctx } from './types.js';

export interface WsData {
  readonly endpoint: string;
  readonly data: unknown;
  /** The client IP of the upgrade request (`ctx.ip`). */
  readonly ip?: string | undefined;
}

export type WsSocket = ServerWebSocket<WsData>;

/** A token bucket: up to `limit` messages, refilled evenly over `windowMs`. */
export interface WsMessageRate {
  limit: number;
  windowMs: number;
}

/** Per-endpoint WebSocket options (`WsRegistry.register(path, endpoint, options)`). */
export interface WsEndpointOptions {
  /**
   * Origins allowed in addition to the same origin (same scheme, host and port as the request).
   * `'*'` disables the check. Upgrades without an Origin header (non-browser clients) are allowed.
   */
  allowedOrigins?: readonly string[] | '*';
  /**
   * Per-socket message rate; a socket that exceeds it is closed with 1008. `false` disables it.
   * Default: the server's `messageRate` (100 messages per 10s).
   */
  messageRate?: WsMessageRate | false;
  /** Closes each socket with 4408 this many milliseconds after it opened. Default: no limit. */
  maxConnectionLifetime?: number;
  /**
   * Route-style metadata for the upgrade request: guards read it as `ctx.meta`, so an endpoint
   * without a GET route can still carry what a global guard requires. On the path of a GET route
   * it is merged over that route's meta for upgrades only. Copied and frozen at register().
   */
  meta?: Readonly<Record<PropertyKey, unknown>>;
}

/** Server-wide WebSocket limits (`listen({ websocket })`). */
export interface WsServerOptions {
  /**
   * Largest accepted message in bytes; a larger one drops the connection (1006). Default 256 KiB,
   * above a 100 KiB GraphQL query plus its graphql-transport-ws envelope.
   */
  maxPayloadLength?: number;
  /** Bytes buffered for a slow reader before backpressure applies. Default 1 MiB. */
  backpressureLimit?: number;
  /** Close a socket that exceeds `backpressureLimit`. Default true. */
  closeOnBackpressureLimit?: boolean;
  /** Seconds without traffic before a socket is closed, at most 960. Default 120. */
  idleTimeout?: number;
  /**
   * Open sockets per client IP (`ctx.ip`, IPv6 grouped by `ipv6Subnet`); more upgrades get 429.
   * `false` disables. Default 100. Behind a proxy without `trustProxy`, every client has the
   * proxy's IP, so this caps the proxy as a whole: configure `trustProxy` or raise it.
   */
  maxConnectionsPerIp?: number | false;
  /**
   * IPv6 prefix length the per-IP limit groups clients by (one client usually controls a whole
   * /64). An integer from 1 to 128; 128 counts full addresses. Default 64.
   */
  ipv6Subnet?: number;
  /** Open sockets in total; more upgrades get 503. Default: no limit. */
  maxConnections?: number;
  /** Default per-socket message rate for every endpoint. Default 100 messages per 10s. */
  messageRate?: WsMessageRate | false;
  /**
   * closeWhere() predicates kept (for up to 30s) for sockets that are still upgrading. A
   * predicate pushed out of this list is first checked against every upgrade that already has
   * its socket data; only upgrades still in their guards, which it could not be checked against,
   * then fail closed. Default 10000.
   */
  maxPendingRevocations?: number;
}

export const WS_DEFAULTS = Object.freeze({
  maxPayloadLength: 256 * 1024,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
  maxConnectionsPerIp: 100,
  ipv6Subnet: 64,
  messageRate: Object.freeze({ limit: 100, windowMs: 10_000 }),
  maxPendingRevocations: 10_000,
});

interface ResolvedServerOptions {
  maxPayloadLength: number;
  backpressureLimit: number;
  closeOnBackpressureLimit: boolean;
  idleTimeout: number;
  maxConnectionsPerIp: number | false;
  ipv6Subnet: number;
  maxConnections: number | undefined;
  messageRate: WsMessageRate | false;
  maxPendingRevocations: number;
}

interface PendingRevocation {
  readonly seq: number;
  readonly at: number;
  readonly predicate: (ws: WsSocket) => boolean;
  readonly code: number;
  readonly reason: string;
}

/** How long, and how many, closeWhere() predicates are kept for sockets still upgrading. */
const REVOCATION_TTL = 30_000;
/** An upgrade whose socket has not opened after this long no longer counts as pending. */
const UPGRADE_TTL = 30_000;
/** Expired upgrades are swept at most this often (amortized, never on every call). */
const SWEEP_INTERVAL = 1_000;

interface UpgradeEntry {
  /** The revocation sequence number current when the upgrade began. */
  readonly seq: number;
  readonly at: number;
  /** Set once the upgrade reserved its socket data. */
  hasData: boolean;
  /**
   * Lost predicates up to this sequence number were accounted for (issued before the upgrade
   * began, or checked against its socket data when they were evicted). A loss above it was
   * never checked against this upgrade, which then fails closed.
   */
  checkedThrough: number;
  /** A lost predicate matched it when it was checked at eviction time. */
  revoked: { code: number; reason: string } | undefined;
}

interface SocketState {
  tokens: number;
  updatedAt: number;
  limited: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The largest delay setTimeout() honours; above it the timer fires after 1 ms. */
const MAX_TIMEOUT = 2 ** 31 - 1;

function assertInteger(name: string, value: unknown, min: number, max?: number): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    const range = max === undefined ? `>= ${min}` : `from ${min} to ${max}`;
    throw new HttpConfigError(
      `WebSocket ${name} must be an integer ${range}, got ${String(value)}.`,
    );
  }
}

function assertRate(name: string, rate: WsMessageRate | false | undefined): void {
  if (rate === undefined || rate === false) return;
  assertInteger(`${name}.limit`, rate.limit, 1);
  assertInteger(`${name}.windowMs`, rate.windowMs, 1);
}

/** `value`, or `fallback` when it is undefined (a key written as `undefined` keeps its default). */
function or<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function resolveServerOptions(options: WsServerOptions): ResolvedServerOptions {
  const o: ResolvedServerOptions = {
    maxPayloadLength: or(options.maxPayloadLength, WS_DEFAULTS.maxPayloadLength),
    backpressureLimit: or(options.backpressureLimit, WS_DEFAULTS.backpressureLimit),
    closeOnBackpressureLimit: or(
      options.closeOnBackpressureLimit,
      WS_DEFAULTS.closeOnBackpressureLimit,
    ),
    idleTimeout: or(options.idleTimeout, WS_DEFAULTS.idleTimeout),
    // false disables the limit; undefined keeps the default.
    maxConnectionsPerIp: or(options.maxConnectionsPerIp, WS_DEFAULTS.maxConnectionsPerIp),
    ipv6Subnet: or(options.ipv6Subnet, WS_DEFAULTS.ipv6Subnet),
    // undefined is the default: no limit.
    maxConnections: options.maxConnections,
    // false disables the rate; undefined keeps the default.
    messageRate: or(options.messageRate, WS_DEFAULTS.messageRate),
    maxPendingRevocations: or(options.maxPendingRevocations, WS_DEFAULTS.maxPendingRevocations),
  };
  assertInteger('maxPayloadLength', o.maxPayloadLength, 1);
  assertInteger('backpressureLimit', o.backpressureLimit, 1);
  if (typeof o.closeOnBackpressureLimit !== 'boolean') {
    throw new HttpConfigError(
      `WebSocket closeOnBackpressureLimit must be a boolean, got ${String(o.closeOnBackpressureLimit)}.`,
    );
  }
  // Bun rejects more than 960s, but a value above 2^31 wraps around instead of being rejected.
  assertInteger('idleTimeout', o.idleTimeout, 0, 960);
  if (o.maxConnectionsPerIp !== false)
    assertInteger('maxConnectionsPerIp', o.maxConnectionsPerIp, 1);
  if (o.maxConnections !== undefined) assertInteger('maxConnections', o.maxConnections, 1);
  // 0 would put every IPv6 client into one group, so it is not accepted.
  if (!isIpv6Prefix(o.ipv6Subnet) || o.ipv6Subnet < 1) {
    throw new HttpConfigError(
      `WebSocket ipv6Subnet must be an integer from 1 to 128, got ${String(o.ipv6Subnet)}.`,
    );
  }
  assertRate('messageRate', o.messageRate);
  assertInteger('maxPendingRevocations', o.maxPendingRevocations, 1);
  return o;
}

/** A plain `host[:port]` or bracketed IPv6 literal with an optional port, and nothing else. */
const HOST_HEADER = /^(?:[a-z0-9._~-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * An allowedOrigins entry must be exactly an origin (`scheme://host[:port]`, any case): a path,
 * query, credentials, default port or wildcard would never be what a browser sends, so the entry
 * would silently match nothing or more than it says.
 */
function assertOrigin(subject: string, entry: unknown): void {
  const origin = typeof entry === 'string' ? originOf(entry) : undefined;
  // `new URL()` accepts `*` in a host, so `https://*.example.com` is an origin that never matches.
  const wildcard = typeof entry === 'string' && entry.includes('*');
  if (!wildcard && origin !== undefined && origin === (entry as string).toLowerCase()) return;
  const shown = JSON.stringify(entry);
  const hint = wildcard
    ? 'wildcards are not supported; list each origin'
    : origin === undefined
      ? 'expected scheme://host[:port]'
      : `expected the bare origin ${JSON.stringify(origin)}`;
  throw new HttpConfigError(`Invalid allowedOrigins entry for ${subject}: ${shown} (${hint}).`);
}

/**
 * Validates an `allowedOrigins` option (`'*'` or an array of exact origins) and returns
 * it normalized for originAllowed(): `'*'`, a new Set of origins, or undefined when unset. Throws
 * HttpConfigError naming `subject` (for example `WebSocket endpoint /ws`) for anything else.
 */
export function normalizeAllowedOrigins(
  subject: string,
  origins: unknown,
): ReadonlySet<string> | '*' | undefined {
  if (origins === undefined || origins === '*') return origins;
  if (!Array.isArray(origins)) {
    throw new HttpConfigError(
      `allowedOrigins for ${subject} must be an array of origins or "*"; got ${JSON.stringify(origins)}.`,
    );
  }
  for (const entry of origins) assertOrigin(subject, entry);
  return new Set(origins.map((entry: string) => originOf(entry)!));
}

/**
 * Whether a WebSocket upgrade's Origin may connect: no Origin header (not a browser), `allowed`
 * is `'*'`, the origin is in `allowed`, or it is the same origin as the request (scheme from
 * `secure`, host and port from `host`, default ports 80/443 normalized). `"null"` is rejected.
 * A set in `allowed` must hold normalized origins (as `new URL(entry).origin` gives them).
 */
export function originAllowed(
  origin: string | null,
  host: string | null,
  secure: boolean,
  allowed?: readonly string[] | ReadonlySet<string> | '*',
): boolean {
  if (origin === null || allowed === '*') return true;
  const normalized = originOf(origin);
  if (normalized === undefined) return false;
  if (Array.isArray(allowed)) {
    if (allowed.some((entry) => originOf(entry) === normalized)) return true;
  } else if ((allowed as ReadonlySet<string> | undefined)?.has(normalized)) {
    return true;
  }
  if (host === null || !HOST_HEADER.test(host)) return false;
  return originOf(`${secure ? 'https' : 'http'}://${host}`) === normalized;
}

export interface WsEndpoint<D = unknown> {
  /** Return socket data to accept, or `false` to reject with 403. Throw an HttpException for other statuses. */
  upgrade(ctx: Ctx): D | false | Promise<D | false>;
  open?(ws: WsSocket): void | Promise<void>;
  message?(ws: WsSocket, message: string | Buffer): void | Promise<void>;
  close?(ws: WsSocket, code: number, reason: string): void | Promise<void>;
  drain?(ws: WsSocket): void | Promise<void>;
}

type WsEvent = 'open' | 'message' | 'close' | 'drain';

/** Own string and symbol keys of `meta`, without invoking a `__proto__` setter. */
function copyOwn(meta: object): Record<PropertyKey, unknown> {
  const out: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(meta)) {
    if (!Object.prototype.propertyIsEnumerable.call(meta, key)) continue;
    Object.defineProperty(out, key, {
      value: (meta as Record<PropertyKey, unknown>)[key],
      enumerable: true,
    });
  }
  return out;
}

/** Bun allows one websocket handler per server; modules register endpoints here instead. */
@Injectable()
export class WsRegistry {
  readonly #endpoints = new Map<string, WsEndpoint<any>>();
  readonly #options = new Map<string, WsEndpointOptions>();
  /** Each endpoint's allowedOrigins, normalized and copied at register(). */
  readonly #origins = new Map<string, ReadonlySet<string> | '*'>();
  readonly #sockets = new Map<WsSocket, SocketState>();
  /** Sockets whose endpoint saw open: only those get message, drain and close. */
  readonly #opened = new WeakSet<WsSocket>();
  /** Upgrade data objects holding a connection slot, with the IP they count against. */
  readonly #reserved = new WeakMap<object, string | undefined>();
  /** Pending holdSlot() calls per socket data: release() keeps the slot until they are done. */
  readonly #holds = new WeakMap<object, number>();
  /** Socket data released while held: the last hold to finish returns the slot. */
  readonly #releasedWhileHeld = new WeakSet<object>();
  readonly #perIp = new Map<string, number>();
  #reservedTotal = 0;
  /** Open streams holding a connection slot, keyed by their data, with the end() for shutdown. */
  readonly #streams = new Map<object, () => void>();
  /** Set by endStreams() (shutdown): later streams are refused, until the next configure(). */
  #streamsEnded = false;
  /** The HTTP idleTimeout (seconds) recorded by the last configure(); Bun's default is 10. */
  #httpIdleTimeout = 10;
  /** Keep-alive intervals (ms) by label, checked against the HTTP idle timeout at configure(). */
  readonly #keepAlives = new Map<string, number>();
  /** Labels of the long-lived streams announced by expectLongLivedStreams(). */
  readonly #longLivedStreams: string[] = [];
  readonly #log = {
    logger: inject(LOGGER),
    development: inject(HTTP_DEVELOPMENT),
  };
  #server: ResolvedServerOptions = resolveServerOptions({});
  #sealed = false;
  /**
   * Upgrades in progress (from the upgrade request until the socket opens or the upgrade
   * fails), keyed by their Ctx and then their socket data. Entries older than 30s (an upgrade
   * whose socket never opened: aborted, timed out) stop counting as pending; their entry is kept
   * in #expiredUpgrades so a late open can still be checked.
   */
  readonly #upgrades = new Map<object, UpgradeEntry>();
  /** The pending upgrades that already reserved their socket data (between reserve and open). */
  readonly #withData = new Map<object, UpgradeEntry>();
  readonly #expiredUpgrades = new WeakMap<object, UpgradeEntry>();
  /**
   * Socket data whose slot was returned when its upgrade expired: a late open takes a slot
   * again, or is closed with 1013 when none is free.
   */
  readonly #expiredSlots = new WeakMap<object, string | undefined>();
  #nextSweep = 0;
  /** closeWhere() calls issued while an upgrade was in progress, oldest first from #head. */
  #revocations: PendingRevocation[] = [];
  #head = 0;
  #revocationSeq = 0;
  /**
   * The newest revocation that could not be kept for every upgrade that might need it (lost to
   * the cap or the TTL, or issued while nothing was pending): expired upgrades older than it
   * fail closed.
   */
  #lostSeq = 0;
  /** #lostSeq before the loss being processed. */
  #lostPrevious = 0;

  register<D>(path: string, endpoint: WsEndpoint<D>, options: WsEndpointOptions = {}): void {
    const normalized = joinPaths(path);
    if (normalized.split('/').some((seg) => seg.startsWith(':') || seg.startsWith('*'))) {
      throw new HttpConfigError(`WebSocket endpoint paths must be exact; got ${normalized}`);
    }
    if (this.#sealed) {
      throw new HttpConfigError(`WebSocket endpoint ${normalized} was registered after listen().`);
    }
    if (this.#endpoints.has(normalized)) {
      throw new HttpConfigError(`Duplicate WebSocket endpoint ${normalized}.`);
    }
    // A copy: changing the caller's array after register() cannot widen the check.
    const origins = normalizeAllowedOrigins(
      `WebSocket endpoint ${normalized}`,
      options.allowedOrigins,
    );
    assertRate(`messageRate of ${normalized}`, options.messageRate);
    if (options.maxConnectionLifetime !== undefined) {
      assertInteger(
        `maxConnectionLifetime of ${normalized}`,
        options.maxConnectionLifetime,
        1,
        MAX_TIMEOUT,
      );
    }
    const meta = options.meta;
    if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
      throw new HttpConfigError(`meta of ${normalized} must be an object`);
    }
    this.#endpoints.set(normalized, endpoint);
    if (origins !== undefined) this.#origins.set(normalized, origins);
    this.#options.set(normalized, {
      ...options,
      meta: meta === undefined ? undefined : Object.freeze(copyOwn(meta)),
    });
  }

  /** @internal The frozen `meta` an endpoint was registered with, if any. */
  meta(path: string): Readonly<Record<PropertyKey, unknown>> | undefined {
    return this.#options.get(path)?.meta;
  }

  /**
   * @internal Called by HttpApplication.listen() with `listen({ websocket })` and its
   * `idleTimeout`. Throws when a keep-alive recorded by `requireKeepAliveBelowIdle()` is more
   * than half a non-zero idle timeout (Bun's default is 10s): Bun checks idle connections on a
   * coarse tick, so a quiet connection can be closed before the full idleTimeout. Logs one
   * warning when long-lived streams were announced (`expectLongLivedStreams()`) and the idle
   * timeout is 1 to 4 s, where Bun may close any quiet stream at its next tick.
   */
  configure(options: WsServerOptions, http?: { idleTimeout?: number }): void {
    const idleTimeout = http?.idleTimeout ?? 10;
    if (idleTimeout !== 0) {
      for (const [label, intervalMs] of this.#keepAlives) {
        if (intervalMs > (idleTimeout * 1000) / 2) {
          throw new HttpConfigError(
            `${label} keep-alive interval (${intervalMs} ms) must be at most half the HTTP ` +
              `idleTimeout (${idleTimeout} s, so at most ${(idleTimeout * 1000) / 2} ms), or ` +
              'idle streams can be closed before a keep-alive is sent.',
          );
        }
      }
    }
    if (idleTimeout >= 1 && idleTimeout <= 4 && this.#longLivedStreams.length > 0) {
      this.#log.logger.warn(
        `${this.#longLivedStreams.join(', ')}: with an HTTP idleTimeout of ${idleTimeout} s, Bun ` +
          'may close quiet streams early whatever keep-alive they send. Use idleTimeout >= 5 ' +
          '(or 0), or turn the streams off (subscriptions.sse: false for GraphQL SSE).',
      );
    }
    this.#server = resolveServerOptions(options);
    this.#streamsEnded = false;
    this.#httpIdleTimeout = idleTimeout;
  }

  /** @internal The HTTP idleTimeout in seconds recorded by `configure()` (0: none; default 10). */
  get httpIdleTimeout(): number {
    return this.#httpIdleTimeout;
  }

  /**
   * @internal Records a stream keep-alive interval that the next `configure()` checks against
   * the HTTP idle timeout. Recording a label again replaces its interval.
   */
  requireKeepAliveBelowIdle(label: string, intervalMs: number): void {
    this.#keepAlives.set(label, intervalMs);
  }

  /**
   * @internal Announces long-lived streaming responses (named by `label`), so `configure()` warns
   * when the HTTP idle timeout is too short for Bun to keep them open.
   */
  expectLongLivedStreams(label: string): void {
    if (!this.#longLivedStreams.includes(label)) this.#longLivedStreams.push(label);
  }

  /**
   * @internal Takes a connection slot for a streaming response, shared with WebSocket
   * connections, or throws 429 (per-IP limit) / 503 (total limit). `end` is called by
   * `endStreams()` at shutdown; `closeStream()` returns the slot. After `endStreams()` (a stream
   * set up while the server shuts down) it throws 503, so no stream outlives shutdown.
   */
  openStream(data: object, ip: string | undefined, end: () => void): void {
    // A second slot under the same key would be counted twice and returned once.
    if (this.#reserved.has(data)) {
      throw new Error('openStream: this data object already holds a connection slot.');
    }
    if (this.#streamsEnded) throw new ServiceUnavailableException('The server is shutting down.');
    this.#take(data, this.#ipKey(ip), 'streaming');
    this.#streams.set(data, end);
  }

  /** @internal Returns a stream's slot and forgets its `end` (no-op if already closed). */
  closeStream(data: object): void {
    if (!this.#streams.delete(data)) return;
    this.#giveBack(data);
  }

  /** @internal Calls `end` of every open stream once (at shutdown); a throw is logged. */
  endStreams(): void {
    this.#streamsEnded = true;
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const [data, end] of streams) {
      this.#giveBack(data);
      try {
        end();
      } catch (error) {
        logError(this.#log, 'Ending a stream at shutdown failed', error);
      }
    }
  }

  /**
   * @internal Called by the compiler before an upgrade's guards run: rejects a disallowed Origin
   * with 403.
   */
  checkOrigin(path: string, ctx: Ctx): void {
    const headers = ctx.req.headers;
    const allowed = this.#origins.get(path);
    if (!originAllowed(headers.get('origin'), headers.get('host'), ctx.secure, allowed)) {
      throw new ForbiddenException('Cross-origin WebSocket connections are not allowed.');
    }
  }

  /**
   * @internal Takes a connection slot for an upgrade's data object right before the upgrade, or
   * throws 429 (per-IP limit) / 503 (total limit). The slot is returned when the socket closes,
   * by `release()` if the upgrade fails, or when the upgrade expires (its socket did not open
   * within 30s); a socket that opens after that takes a slot again, or is closed with 1013.
   */
  reserve(data: object, ip: string | undefined, ctx?: object): void {
    this.#take(data, this.#ipKey(ip), 'WebSocket');
    // The in-progress upgrade now follows its socket data, until the socket opens.
    if (ctx === undefined) return;
    const entry = this.#upgrades.get(ctx);
    if (entry !== undefined) {
      this.#upgrades.delete(ctx);
      entry.hasData = true;
      this.#upgrades.set(data, entry);
      this.#withData.set(data, entry);
      return;
    }
    // The upgrade expired while in its guards: it is pending again from now, so its slot is
    // returned if its socket never opens. Its marks are kept, so it still fails closed at open
    // for a predicate it missed.
    const expired = this.#expiredUpgrades.get(ctx);
    if (expired !== undefined) {
      const revived: UpgradeEntry = { ...expired, at: Date.now(), hasData: true };
      this.#upgrades.set(data, revived);
      this.#withData.set(data, revived);
    }
  }

  /** The key a connection from `ip` counts against: its masked IP, or none when unlimited. */
  #ipKey(ip: string | undefined): string | undefined {
    if (this.#server.maxConnectionsPerIp === false || ip === undefined) return undefined;
    return maskIp(ip, this.#server.ipv6Subnet);
  }

  /**
   * Takes a slot counted against `key` (the masked IP, if limited), or throws 429 / 503 naming
   * the `kind` of connection.
   */
  #take(data: object, key: string | undefined, kind: 'WebSocket' | 'streaming'): void {
    const { maxConnections, maxConnectionsPerIp } = this.#server;
    if (maxConnections !== undefined && this.#reservedTotal >= maxConnections) {
      throw new ServiceUnavailableException(`Too many ${kind} connections.`);
    }
    if (key !== undefined && (this.#perIp.get(key) ?? 0) >= (maxConnectionsPerIp as number)) {
      throw new TooManyRequestsException(`Too many ${kind} connections from this address.`);
    }
    this.#reservedTotal++;
    if (key !== undefined) this.#perIp.set(key, (this.#perIp.get(key) ?? 0) + 1);
    this.#reserved.set(data, key);
  }

  /** Returns the slot held by `data`, if any. */
  #giveBack(data: object): void {
    if (!this.#reserved.has(data)) return;
    const key = this.#reserved.get(data);
    this.#reserved.delete(data);
    this.#reservedTotal--;
    if (key !== undefined) {
      const count = (this.#perIp.get(key) ?? 1) - 1;
      if (count > 0) this.#perIp.set(key, count);
      else this.#perIp.delete(key);
    }
  }

  /** @internal Called by the compiler when an upgrade request arrives (before middleware). */
  beginUpgrade(ctx: object): void {
    const now = Date.now();
    this.#sweep(now);
    if (this.#upgrades.has(ctx)) return;
    this.#upgrades.set(ctx, {
      seq: this.#revocationSeq,
      at: now,
      hasData: false,
      checkedThrough: this.#revocationSeq,
      revoked: undefined,
    });
  }

  /** @internal Ends an upgrade that did not open a socket (no-op once it moved to its data). */
  endUpgrade(key: object): void {
    this.#upgrades.delete(key);
    this.#withData.delete(key);
  }

  /** The `websocket.maxPendingRevocations` limit in effect. */
  get maxPendingRevocations(): number {
    return this.#server.maxPendingRevocations;
  }

  /** @internal Upgrades currently in progress (for tests). */
  get upgradesInProgress(): number {
    this.#sweep(Date.now(), true);
    return this.#upgrades.size;
  }

  /**
   * Moves upgrades that never opened within the TTL out of the pending set, so the count cannot
   * drift upwards. Runs at most once per second (or when forced), so it is amortized O(1).
   */
  #sweep(now: number, force = false): void {
    if (!force && now < this.#nextSweep) return;
    this.#nextSweep = now + SWEEP_INTERVAL;
    // Expired predicates are checked against the upgrades with socket data before any of those
    // upgrades leave the pending set.
    this.#pruneRevocations(now);
    for (const [key, entry] of this.#upgrades) {
      if (now - entry.at <= UPGRADE_TTL) continue;
      this.#upgrades.delete(key);
      this.#withData.delete(key);
      this.#expiredUpgrades.set(key, entry);
      // Its socket never opened: the slot is returned, so aborted upgrades cannot exhaust the
      // limits. A late open takes one again (#retake).
      if (entry.hasData && this.#reserved.has(key)) {
        this.#expiredSlots.set(key, this.#reserved.get(key));
        this.#giveBack(key);
      }
    }
  }

  /**
   * A socket whose upgrade expired (and returned its slot) opens late: it takes a slot again.
   * Returns false, after closing it with 1013, when none is free.
   */
  #retake(ws: WsSocket): boolean {
    const data = ws.data;
    if (!this.#expiredSlots.has(data)) return true;
    const key = this.#expiredSlots.get(data);
    this.#expiredSlots.delete(data);
    try {
      this.#take(data, key, 'WebSocket');
      return true;
    } catch {
      ws.close(1013, 'Too many WebSocket connections');
      return false;
    }
  }

  /**
   * @internal Returns the connection slot held by an upgrade's data object, if any. While a
   * holdSlot() of it is pending, the slot is returned only when the last hold is done.
   */
  release(data: object): void {
    this.endUpgrade(data);
    this.#expiredSlots.delete(data);
    if (this.#holds.has(data)) {
      this.#releasedWhileHeld.add(data);
      return;
    }
    this.#giveBack(data);
  }

  /**
   * @internal Keeps the slot of a socket's data taken while work for the socket is pending (an
   * endpoint's connection handshake), even after the socket closes, so clients that disconnect
   * cannot pile up that work past the connection limits. Returns `done`, which ends the hold
   * (idempotent); a socket that closed meanwhile then gives its slot back.
   */
  holdSlot(data: object): () => void {
    this.#holds.set(data, (this.#holds.get(data) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#holds.get(data) ?? 1) - 1;
      if (left > 0) {
        this.#holds.set(data, left);
        return;
      }
      this.#holds.delete(data);
      if (this.#releasedWhileHeld.delete(data)) this.#giveBack(data);
    };
  }

  get(path: string): WsEndpoint | undefined {
    return this.#endpoints.get(path);
  }

  entries(): IterableIterator<[string, WsEndpoint]> {
    return this.#endpoints.entries();
  }

  get openSockets(): number {
    return this.#sockets.size;
  }

  /** @internal Called by the compiler at listen(). */
  seal(): void {
    this.#sealed = true;
  }

  handler(): WebSocketHandler<WsData> {
    const limits = this.#server;
    return {
      maxPayloadLength: limits.maxPayloadLength,
      backpressureLimit: limits.backpressureLimit,
      closeOnBackpressureLimit: limits.closeOnBackpressureLimit,
      idleTimeout: limits.idleTimeout,
      open: async (ws) => {
        // Sweep first, so an upgrade that expired just now returns its slot before it is taken.
        this.#sweep(Date.now());
        if (!this.#retake(ws)) {
          this.endUpgrade(ws.data);
          return;
        }
        this.#sockets.set(ws, this.#openState(ws));
        // Revocations issued while this socket was upgrading are applied before the endpoint
        // sees it. Fail closed when one of them can no longer be checked.
        // Expire predicates first, so they are checked against this upgrade while it is pending.
        this.#pruneRevocations(Date.now());
        const entry = this.#upgrades.get(ws.data) ?? this.#expiredUpgrades.get(ws.data);
        this.endUpgrade(ws.data);
        if (entry !== undefined && this.#reapply(ws, entry)) return;
        // Marked before open runs, so messages that arrive while an async open is pending are
        // still delivered.
        this.#opened.add(ws);
        // An endpoint that failed to set up its socket must not serve it (fail closed).
        if (!(await this.#dispatch(ws, 'open'))) ws.close(1011, 'Internal error');
      },
      message: async (ws, message) => {
        if (!this.#opened.has(ws) || !this.#admitMessage(ws)) return;
        await this.#dispatch(ws, 'message', message);
      },
      close: async (ws, code, reason) => {
        const state = this.#sockets.get(ws);
        if (state?.timer !== undefined) clearTimeout(state.timer);
        this.#sockets.delete(ws);
        this.release(ws.data);
        // An idle registry holds no predicate closures.
        if (this.#upgrades.size === 0) this.#dropKept();
        if (!this.#opened.has(ws)) return;
        this.#opened.delete(ws);
        await this.#dispatch(ws, 'close', code, reason);
      },
      drain: async (ws) => {
        if (this.#opened.has(ws)) await this.#dispatch(ws, 'drain');
      },
    };
  }

  closeAll(code = 1001, reason = 'Server shutting down'): void {
    for (const ws of this.#sockets.keys()) ws.close(code, reason);
  }

  /**
   * Closes every open socket for which `predicate` returns a truthy value (for example, all sockets of a
   * signed-out user, found through `ws.data.data`), and returns how many were closed. Predicates
   * should read only `ws.data`: for a socket still upgrading they may be evaluated against a
   * stand-in that has nothing else, and one that reads more makes that socket fail closed. Sockets
   * whose upgrade is still in progress are checked when they open (the predicate is kept for up
   * to 30s, at most `maxPendingRevocations`). A predicate that throws for a socket is logged and
   * that socket is left open.
   */
  closeWhere(
    predicate: (ws: WsSocket) => boolean,
    code = 1008,
    reason = 'Connection revoked',
  ): number {
    // Sockets still upgrading (in guards, or between server.upgrade() and open) are not in
    // #sockets yet: the predicate is kept and applied to them when they open.
    const now = Date.now();
    this.#sweep(now);
    if (this.#upgrades.size > 0) this.#record(predicate, code, reason, now);
    else {
      // Nothing is pending to keep it for: only an expired upgrade could have needed it. The
      // predicates kept so far are no longer needed by anyone either.
      this.#lostSeq = ++this.#revocationSeq;
      this.#dropKept();
    }
    let count = 0;
    for (const ws of [...this.#sockets.keys()]) {
      let matches: boolean;
      try {
        matches = predicate(ws);
      } catch (error) {
        // One bad socket (or a predicate bug) must not stop the revocation of the others.
        logError(
          this.#log,
          `WsRegistry.closeWhere predicate threw for ${logValue(ws.data.endpoint)}`,
          error,
        );
        continue;
      }
      if (!matches) continue;
      ws.close(code, reason);
      count++;
    }
    return count;
  }

  /**
   * Applies what happened while this socket was upgrading, and returns whether it closed the
   * socket: a predicate that matched it when it was evicted, a kept predicate issued after its
   * upgrade began, or (fail closed, 1008) a predicate it could not be checked against.
   */
  #reapply(ws: WsSocket, entry: UpgradeEntry): boolean {
    if (entry.revoked) {
      ws.close(entry.revoked.code, entry.revoked.reason);
      return true;
    }
    // Fail closed only when a lost predicate was never checked against this upgrade (it was
    // still in its guards, or no longer pending), however long the upgrade took.
    if (this.#lostSeq > entry.checkedThrough) {
      ws.close(1008, 'Revocation state unavailable');
      return true;
    }
    for (let i = this.#firstAfter(entry.seq); i < this.#revocations.length; i++) {
      const revocation = this.#revocations[i]!;
      if (this.#matches(revocation, ws)) {
        ws.close(revocation.code, revocation.reason);
        return true;
      }
    }
    return false;
  }

  /** Index of the first kept revocation with a sequence number above `seq` (binary search). */
  #firstAfter(seq: number): number {
    let lo = this.#head;
    let hi = this.#revocations.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#revocations[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #matches(revocation: PendingRevocation, ws: WsSocket): boolean {
    try {
      // The same rule as for open sockets in closeWhere(): any truthy result revokes.
      return Boolean(revocation.predicate(ws));
    } catch (error) {
      logError(
        this.#log,
        `WsRegistry.closeWhere predicate threw for ${logValue(ws.data.endpoint)}`,
        error,
      );
      return false;
    }
  }

  /**
   * A predicate leaves the kept list (cap or TTL): check it now against every pending upgrade
   * that already has its socket data. Upgrades still in their guards are not walked: their
   * `checkedThrough` stays behind #lostSeq, so they fail closed at open.
   */
  #lose(revocation: PendingRevocation): void {
    this.#lostPrevious = this.#lostSeq;
    this.#lostSeq = Math.max(this.#lostSeq, revocation.seq);
    for (const [key, entry] of this.#withData) {
      // Only an upgrade that was accounted for up to now stays accounted for.
      if (entry.checkedThrough < this.#lostPrevious) continue;
      if (entry.revoked || entry.seq >= revocation.seq) {
        entry.checkedThrough = Math.max(entry.checkedThrough, revocation.seq);
        continue;
      }
      // The socket does not exist yet: the predicate gets a stand-in that has only `data`. A
      // predicate that reads anything else was not really evaluated, so this upgrade is not
      // marked checked and fails closed at open.
      let evaluated = true;
      const standIn = new Proxy({} as WsSocket, {
        get: (_target, prop) => {
          if (prop === 'data') return key;
          evaluated = false;
          return undefined;
        },
      });
      const matched = this.#matches(revocation, standIn);
      if (!evaluated) continue;
      entry.checkedThrough = Math.max(entry.checkedThrough, revocation.seq);
      if (matched) entry.revoked = { code: revocation.code, reason: revocation.reason };
    }
  }

  /** Drops every kept predicate when no upgrade is pending (only expired ones could need them). */
  #dropKept(): void {
    if (this.#head >= this.#revocations.length) return;
    this.#lostSeq = Math.max(this.#lostSeq, this.#revocations[this.#revocations.length - 1]!.seq);
    this.#revocations = [];
    this.#head = 0;
  }

  /** @internal Kept closeWhere() predicates (for tests). */
  get keptRevocations(): number {
    return this.#revocations.length - this.#head;
  }

  #pruneRevocations(now: number): void {
    const max = this.#server.maxPendingRevocations;
    while (
      this.#head < this.#revocations.length &&
      (now - this.#revocations[this.#head]!.at > REVOCATION_TTL ||
        this.#revocations.length - this.#head > max)
    ) {
      this.#lose(this.#revocations[this.#head++]!);
    }
    // Compact once the dropped prefix is large, so eviction stays amortized O(1).
    if (this.#head > 1024 && this.#head * 2 > this.#revocations.length) {
      this.#revocations = this.#revocations.slice(this.#head);
      this.#head = 0;
    }
  }

  #record(predicate: (ws: WsSocket) => boolean, code: number, reason: string, now: number): void {
    this.#revocations.push({ seq: ++this.#revocationSeq, at: now, predicate, code, reason });
    this.#pruneRevocations(now);
  }

  #rateOf(ws: WsSocket): WsMessageRate | false {
    return this.#options.get(ws.data.endpoint)?.messageRate ?? this.#server.messageRate;
  }

  #openState(ws: WsSocket): SocketState {
    const rate = this.#rateOf(ws);
    const state: SocketState = {
      tokens: rate === false ? 0 : rate.limit,
      updatedAt: performance.now(),
      limited: false,
      timer: undefined,
    };
    const lifetime = this.#options.get(ws.data.endpoint)?.maxConnectionLifetime;
    if (lifetime !== undefined) {
      state.timer = setTimeout(() => {
        if (this.#sockets.has(ws)) ws.close(4408, 'Connection lifetime exceeded');
      }, lifetime);
      state.timer.unref?.();
    }
    return state;
  }

  /** Token bucket per socket; a socket over its rate is closed with 1008 and gets no more messages. */
  #admitMessage(ws: WsSocket): boolean {
    const rate = this.#rateOf(ws);
    if (rate === false) return true;
    let state = this.#sockets.get(ws);
    if (!state) {
      state = this.#openState(ws);
      this.#sockets.set(ws, state);
    }
    if (state.limited) return false;
    const now = performance.now();
    state.tokens = Math.min(
      rate.limit,
      state.tokens + ((now - state.updatedAt) * rate.limit) / rate.windowMs,
    );
    state.updatedAt = now;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }
    state.limited = true;
    ws.close(1008, 'Message rate exceeded');
    return false;
  }

  /** Runs the endpoint's handler for `event`; returns false when it threw (the error is logged). */
  async #dispatch(ws: WsSocket, event: WsEvent, ...args: unknown[]): Promise<boolean> {
    const endpoint = this.#endpoints.get(ws.data.endpoint);
    const fn = endpoint?.[event] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) return true;
    try {
      await fn.call(endpoint, ws, ...args);
      return true;
    } catch (error) {
      logError(
        this.#log,
        `WebSocket ${event} handler for ${logValue(ws.data.endpoint)} threw`,
        error,
      );
      return false;
    }
  }
}
