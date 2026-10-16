import { inject } from '@hpmws/core';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { ForbiddenException, HttpConfigError } from './exceptions.js';
import { LOGGER } from './logger.js';
import { joinPaths } from './path.js';
import type { Ctx } from './types.js';

export interface WsData {
  readonly endpoint: string;
  readonly data: unknown;
}

export type WsSocket = ServerWebSocket<WsData>;

/** Per-endpoint WebSocket options (`WsRegistry.register(path, endpoint, options)`). */
export interface WsEndpointOptions {
  /**
   * Origins allowed in addition to the same origin (same scheme, host and port as the request).
   * `'*'` disables the check. Upgrades without an Origin header (non-browser clients) are allowed.
   */
  allowedOrigins?: readonly string[] | '*';
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
  readonly #sockets = new Set<WsSocket>();
  readonly #logger = inject(LOGGER);
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
    this.#endpoints.set(normalized, endpoint);
    this.#options.set(normalized, { ...options });
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
    return {
      open: (ws) => {
        this.#sockets.add(ws);
        return this.#dispatch(ws, 'open');
      },
      message: (ws, message) => this.#dispatch(ws, 'message', message),
      close: (ws, code, reason) => {
        this.#sockets.delete(ws);
        return this.#dispatch(ws, 'close', code, reason);
      },
      drain: (ws) => this.#dispatch(ws, 'drain'),
    };
  }

  closeAll(code = 1001, reason = 'Server shutting down'): void {
    for (const ws of this.#sockets) ws.close(code, reason);
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
