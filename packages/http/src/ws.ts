import { inject } from '@hpmws/core';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { HttpConfigError } from './exceptions.js';
import { LOGGER } from './logger.js';
import { joinPaths } from './path.js';
import type { Ctx } from './types.js';

export interface WsData {
  readonly endpoint: string;
  readonly data: unknown;
}

export type WsSocket = ServerWebSocket<WsData>;

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
  readonly #sockets = new Set<WsSocket>();
  readonly #logger = inject(LOGGER);
  #sealed = false;

  register<D>(path: string, endpoint: WsEndpoint<D>): void {
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
    this.#endpoints.set(normalized, endpoint);
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
