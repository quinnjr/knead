import { Injectable, inject } from '@knead-js/core';
import { logError } from './error-log.js';
import { HttpConfigError, ServiceUnavailableException } from './exceptions.js';
import { LOGGER } from './logger.js';
import { HTTP_DEVELOPMENT } from './tokens.js';
import { connectionSlotsOf, WsRegistry } from './ws.js';

/** Bun's HTTP `idleTimeout` in seconds when `listen({ idleTimeout })` is not set. */
export const BUN_DEFAULT_IDLE_TIMEOUT = 10;

/**
 * @internal Framework-internal: long-lived streaming responses (GraphQL SSE subscriptions) and
 * their connection slots, shared with WebSocket connections (`listen({ websocket })` limits:
 * `429` per IP, `503` in total). HttpApplication configures it at `listen()` and ends its streams
 * at `close()`. Application code should not call it: a stream opened here is never ended by the
 * transport that owns it. It stays injectable (a global provider, like WsRegistry), which is
 * accepted: application code is trusted, and GraphQL's own streams are private to that package.
 */
@Injectable()
export class StreamRegistry {
  readonly #slots = connectionSlotsOf(inject(WsRegistry));
  readonly #log = {
    logger: inject(LOGGER),
    development: inject(HTTP_DEVELOPMENT),
  };
  /** Open streams holding a connection slot, keyed by their data, with the end() for shutdown. */
  readonly #streams = new Map<object, () => void>();
  /** Set by endStreams() (shutdown): later streams are refused, until the next configure(). */
  #ended = false;
  /** The HTTP idleTimeout (seconds) recorded by the last configure(). */
  #httpIdleTimeout = BUN_DEFAULT_IDLE_TIMEOUT;
  /** Keep-alive intervals (ms) by label, checked against the HTTP idle timeout at configure(). */
  readonly #keepAlives = new Map<string, number>();
  /** Labels of the long-lived streams announced by expectLongLivedStreams(). */
  readonly #longLivedStreams: string[] = [];

  /**
   * @internal Called by HttpApplication.listen() with its `idleTimeout`. Throws when a keep-alive
   * recorded by `requireKeepAliveBelowIdle()` is more than `maxKeepAliveMs` (half a non-zero idle
   * timeout; Bun's default is 10s): Bun checks idle connections on a coarse tick, so a quiet
   * connection can be closed before the full idleTimeout. Logs one warning when long-lived
   * streams were announced (`expectLongLivedStreams()`) and the idle timeout is 1 to 4 s, where
   * Bun may close any quiet stream at its next tick. Streams are accepted again after it.
   */
  configure(http: { idleTimeout?: number | undefined } = {}): void {
    const idleTimeout = http.idleTimeout ?? BUN_DEFAULT_IDLE_TIMEOUT;
    const max = maxKeepAliveOf(idleTimeout);
    if (max !== undefined) {
      for (const [label, intervalMs] of this.#keepAlives) {
        if (intervalMs > max) {
          throw new HttpConfigError(
            `${label} keep-alive interval (${intervalMs} ms) must be at most half the HTTP ` +
              `idleTimeout (${idleTimeout} s, so at most ${max} ms), or ` +
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
    this.#ended = false;
    this.#httpIdleTimeout = idleTimeout;
  }

  /** @internal The HTTP idleTimeout in seconds recorded by `configure()` (0: none; default 10). */
  get httpIdleTimeout(): number {
    return this.#httpIdleTimeout;
  }

  /**
   * @internal The longest keep-alive interval (ms) a stream may use under the recorded HTTP idle
   * timeout: half of it, or undefined when the idle timeout is 0 (none).
   */
  get maxKeepAliveMs(): number | undefined {
    return maxKeepAliveOf(this.#httpIdleTimeout);
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
    if (this.#slots.has(data)) {
      throw new Error('openStream: this data object already holds a connection slot.');
    }
    if (this.#ended) throw new ServiceUnavailableException('The server is shutting down.');
    this.#slots.take(data, this.#slots.keyOf(ip), 'streaming');
    this.#streams.set(data, end);
  }

  /** @internal Returns a stream's slot and forgets its `end` (no-op if already closed). */
  closeStream(data: object): void {
    if (!this.#streams.delete(data)) return;
    this.#slots.giveBack(data);
  }

  /**
   * @internal Called by HttpApplication.close() before it drains in-flight requests: calls `end`
   * of every open stream once; a throw is logged. Later streams are refused until `configure()`.
   */
  endStreams(): void {
    this.#ended = true;
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const [data, end] of streams) {
      this.#slots.giveBack(data);
      try {
        end();
      } catch (error) {
        logError(this.#log, 'Ending a stream at shutdown failed', error);
      }
    }
  }
}

/** Half `idleTimeout` (seconds) in milliseconds, or undefined when it is 0 (no idle timeout). */
function maxKeepAliveOf(idleTimeout: number): number | undefined {
  return idleTimeout === 0 ? undefined : (idleTimeout * 1000) / 2;
}
