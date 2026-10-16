import { inject } from '@hpmws/core';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import {
  ForbiddenException,
  HttpConfigError,
  ServiceUnavailableException,
  TooManyRequestsException,
} from './exceptions.js';
import { LOGGER } from './logger.js';
import { maskIp } from './net.js';
import { joinPaths } from './path.js';
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
}

/** Server-wide WebSocket limits (`listen({ websocket })`). */
export interface WsServerOptions {
  /** Largest accepted message in bytes; a larger one drops the connection (1006). Default 64 KiB. */
  maxPayloadLength?: number;
  /** Bytes buffered for a slow reader before backpressure applies. Default 1 MiB. */
  backpressureLimit?: number;
  /** Close a socket that exceeds `backpressureLimit`. Default true. */
  closeOnBackpressureLimit?: boolean;
  /** Seconds without traffic before a socket is closed. Default 120. */
  idleTimeout?: number;
  /**
   * Open sockets per client IP (`ctx.ip`, IPv6 grouped by `ipv6Subnet`); more upgrades get 429.
   * `false` disables. Default 100. Behind a proxy without `trustProxy`, every client has the
   * proxy's IP, so this caps the proxy as a whole: configure `trustProxy` or raise it.
   */
  maxConnectionsPerIp?: number | false;
  /**
   * IPv6 prefix length the per-IP limit groups clients by (one client usually controls a whole
   * /64). 128 counts full addresses. Default 64.
   */
  ipv6Subnet?: number;
  /** Open sockets in total; more upgrades get 503. Default: no limit. */
  maxConnections?: number;
  /** Default per-socket message rate for every endpoint. Default 100 messages per 10s. */
  messageRate?: WsMessageRate | false;
}

export const WS_DEFAULTS = Object.freeze({
  maxPayloadLength: 64 * 1024,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
  maxConnectionsPerIp: 100,
  ipv6Subnet: 64,
  messageRate: Object.freeze({ limit: 100, windowMs: 10_000 }),
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
}

interface SocketState {
  tokens: number;
  updatedAt: number;
  limited: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function assertInteger(name: string, value: unknown, min: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new HttpConfigError(
      `WebSocket ${name} must be an integer >= ${min}, got ${String(value)}.`,
    );
  }
}

function assertRate(name: string, rate: WsMessageRate | false | undefined): void {
  if (rate === undefined || rate === false) return;
  assertInteger(`${name}.limit`, rate.limit, 1);
  assertInteger(`${name}.windowMs`, rate.windowMs, 1);
}

function resolveServerOptions(options: WsServerOptions): ResolvedServerOptions {
  const o = { ...WS_DEFAULTS, maxConnections: undefined, ...options };
  assertInteger('maxPayloadLength', o.maxPayloadLength, 1);
  assertInteger('backpressureLimit', o.backpressureLimit, 1);
  assertInteger('idleTimeout', o.idleTimeout, 0);
  if (o.maxConnectionsPerIp !== false)
    assertInteger('maxConnectionsPerIp', o.maxConnectionsPerIp, 1);
  if (o.maxConnections !== undefined) assertInteger('maxConnections', o.maxConnections, 1);
  assertInteger('ipv6Subnet', o.ipv6Subnet, 1);
  if (o.ipv6Subnet > 128) {
    throw new HttpConfigError(`WebSocket ipv6Subnet must be at most 128, got ${o.ipv6Subnet}.`);
  }
  assertRate('messageRate', o.messageRate);
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
 * Whether a WebSocket upgrade's Origin may connect: no Origin header (not a browser), `allowed`
 * is `'*'`, the origin is in `allowed`, or it is the same origin as the request (scheme from
 * `secure`, host and port from `host`, default ports 80/443 normalized). `"null"` is rejected.
 */
export function originAllowed(
  origin: string | null,
  host: string | null,
  secure: boolean,
  allowed?: readonly string[] | '*',
): boolean {
  if (origin === null || allowed === '*') return true;
  const normalized = originOf(origin);
  if (normalized === undefined) return false;
  if (allowed?.some((entry) => originOf(entry) === normalized)) return true;
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

/** Bun allows one websocket handler per server; modules register endpoints here instead. */
export class WsRegistry {
  readonly #endpoints = new Map<string, WsEndpoint<any>>();
  readonly #options = new Map<string, WsEndpointOptions>();
  readonly #sockets = new Map<WsSocket, SocketState>();
  /** Upgrade data objects holding a connection slot, with the IP they count against. */
  readonly #reserved = new WeakMap<object, string | undefined>();
  readonly #perIp = new Map<string, number>();
  #reservedTotal = 0;
  readonly #logger = inject(LOGGER);
  #server: ResolvedServerOptions = resolveServerOptions({});
  #sealed = false;

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
    const origins = options.allowedOrigins;
    if (origins !== undefined && origins !== '*') {
      for (const origin of origins) {
        if (originOf(origin) === undefined) {
          throw new HttpConfigError(
            `Invalid allowedOrigins entry for WebSocket endpoint ${normalized}: ${JSON.stringify(origin)}`,
          );
        }
      }
    }
    assertRate(`messageRate of ${normalized}`, options.messageRate);
    if (options.maxConnectionLifetime !== undefined) {
      assertInteger(`maxConnectionLifetime of ${normalized}`, options.maxConnectionLifetime, 1);
    }
    this.#endpoints.set(normalized, endpoint);
    this.#options.set(normalized, { ...options });
  }

  /** @internal Called by HttpApplication.listen() with `listen({ websocket })`. */
  configure(options: WsServerOptions): void {
    this.#server = resolveServerOptions(options);
  }

  /**
   * @internal Called by the compiler before an upgrade's guards run: rejects a disallowed Origin
   * with 403.
   */
  checkOrigin(path: string, ctx: Ctx): void {
    const headers = ctx.req.headers;
    const allowed = this.#options.get(path)?.allowedOrigins;
    if (!originAllowed(headers.get('origin'), headers.get('host'), ctx.secure, allowed)) {
      throw new ForbiddenException('Cross-origin WebSocket connections are not allowed.');
    }
  }

  /**
   * @internal Takes a connection slot for an upgrade's data object right before the upgrade, or
   * throws 429 (per-IP limit) / 503 (total limit). The slot is returned when the socket closes,
   * or by `release()` if the upgrade fails.
   */
  reserve(data: object, ip: string | undefined): void {
    const { maxConnections, maxConnectionsPerIp } = this.#server;
    if (maxConnections !== undefined && this.#reservedTotal >= maxConnections) {
      throw new ServiceUnavailableException('Too many WebSocket connections.');
    }
    const key =
      maxConnectionsPerIp === false || ip === undefined
        ? undefined
        : maskIp(ip, this.#server.ipv6Subnet);
    if (key !== undefined && (this.#perIp.get(key) ?? 0) >= (maxConnectionsPerIp as number)) {
      throw new TooManyRequestsException('Too many WebSocket connections from this address.');
    }
    this.#reservedTotal++;
    if (key !== undefined) this.#perIp.set(key, (this.#perIp.get(key) ?? 0) + 1);
    this.#reserved.set(data, key);
  }

  /** @internal Returns the connection slot held by an upgrade's data object, if any. */
  release(data: object): void {
    if (!this.#reserved.has(data)) return;
    const key = this.#reserved.get(data);
    this.#reserved.delete(data);
    this.#reservedTotal--;
    if (key === undefined) return;
    const count = (this.#perIp.get(key) ?? 1) - 1;
    if (count > 0) this.#perIp.set(key, count);
    else this.#perIp.delete(key);
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
      open: (ws) => {
        this.#sockets.set(ws, this.#openState(ws));
        return this.#dispatch(ws, 'open');
      },
      message: (ws, message) => {
        if (!this.#admitMessage(ws)) return;
        return this.#dispatch(ws, 'message', message);
      },
      close: (ws, code, reason) => {
        const state = this.#sockets.get(ws);
        if (state?.timer !== undefined) clearTimeout(state.timer);
        this.#sockets.delete(ws);
        this.release(ws.data);
        return this.#dispatch(ws, 'close', code, reason);
      },
      drain: (ws) => this.#dispatch(ws, 'drain'),
    };
  }

  closeAll(code = 1001, reason = 'Server shutting down'): void {
    for (const ws of this.#sockets.keys()) ws.close(code, reason);
  }

  /**
   * Closes every open socket for which `predicate` returns true (for example, all sockets of a
   * signed-out user, found through `ws.data.data`), and returns how many were closed. A
   * predicate that throws for a socket is logged and that socket is left open.
   */
  closeWhere(
    predicate: (ws: WsSocket) => boolean,
    code = 1008,
    reason = 'Connection revoked',
  ): number {
    let count = 0;
    for (const ws of [...this.#sockets.keys()]) {
      let matches: boolean;
      try {
        matches = predicate(ws);
      } catch (error) {
        // One bad socket (or a predicate bug) must not stop the revocation of the others.
        this.#logger.error(`WsRegistry.closeWhere predicate threw for ${ws.data.endpoint}`, error);
        continue;
      }
      if (!matches) continue;
      ws.close(code, reason);
      count++;
    }
    return count;
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

  async #dispatch(ws: WsSocket, event: WsEvent, ...args: unknown[]): Promise<void> {
    const endpoint = this.#endpoints.get(ws.data.endpoint);
    const fn = endpoint?.[event] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) return;
    try {
      await fn.call(endpoint, ws, ...args);
    } catch (error) {
      this.#logger.error(`WebSocket ${event} handler for ${ws.data.endpoint} threw`, error);
    }
  }
}
