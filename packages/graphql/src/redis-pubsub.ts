import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConsoleLogger, HttpConfigError, type Logger, logError } from '@hpmws/http';
import type { PubSubEngine } from '@leaven-graphql/ws';
import { RedisClient } from 'bun';

export interface RedisPubSubOptions {
  /** Publisher connection (not closed by close()). The subscriber is always a dedicated duplicate. */
  client?: RedisClient;
  /** Connection URL when no client is given (default: Bun's REDIS_URL / localhost). */
  url?: string;
  /** Channel prefix. Default 'hpmws:gql:'. */
  prefix?: string;
  /** Where failures are reported. Default: the application's LOGGER once GraphQLModule starts. */
  logger?: Logger;
  /**
   * Shared secret (at least 32 bytes) for HMAC-SHA256 message signatures over the channel
   * (prefix + topic), a millisecond timestamp and the payload. Every instance must use the same
   * key; messages without a valid signature, older than `maxSignatureAge` or dated more than 60s
   * ahead are dropped and logged. Use it when other clients can publish to the Redis server.
   * A captured message can still be replayed on the same channel inside that window.
   */
  signingKey?: string | Uint8Array;
  /** Oldest signed message accepted, in milliseconds. Default 60000. */
  maxSignatureAge?: number;
}

/**
 * Hex-encoded HMAC-SHA256 length; a signed message is `<signature>.<ts>.<payload JSON>`, the
 * MAC covering `<prefix><topic>\0<ts>\0<payload JSON>`.
 */
const SIGNATURE_LENGTH = 64;
/** Clock skew tolerated for messages dated in the future. */
const MAX_FUTURE_SKEW = 60_000;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1'
  );
}

/** The host of a plain redis:// URL to a non-loopback host, or undefined. */
function plaintextRemoteHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'redis:' && !isLoopbackHost(parsed.hostname)
      ? parsed.host
      : undefined;
  } catch {
    return undefined;
  }
}

interface Listener {
  callback: (payload: unknown) => void;
  onError: ((error: Error) => void) | undefined;
}

/**
 * PubSubEngine on Bun.redis for multi-instance deployments. Payloads are JSON. Redis requires a
 * connection in subscriber mode to do nothing else, so subscriptions use a dedicated connection.
 * If that connection or a SUBSCRIBE fails, the failure is logged, every subscriber of the topic
 * is told through its `onError` (ending its GraphQL subscription), and the next subscriber retries.
 * `publish()` never rejects (failures are logged); `publishOrThrow()` does. Connect with
 * `rediss://` and an ACL user limited to the prefix's channels in production, and set
 * `signingKey` when anything else can publish to the server.
 */
export class RedisPubSub implements PubSubEngine {
  readonly #publisher: RedisClient;
  readonly #owned: boolean;
  readonly #prefix: string;
  readonly #topics = new Map<string, Set<Listener>>();
  /**
   * Per-topic queue of Redis SUBSCRIBE/UNSUBSCRIBE calls. They run one after another, so an
   * UNSUBSCRIBE never overtakes the SUBSCRIBE it undoes (which would leave the channel
   * subscribed, and a later SUBSCRIBE would then register a second handler).
   */
  readonly #redisOps = new Map<string, Promise<void>>();
  /** Listener sets whose Redis SUBSCRIBE succeeded (and so need an UNSUBSCRIBE). */
  readonly #subscribed = new WeakSet<Set<Listener>>();
  #logger: Logger;
  #explicitLogger: boolean;
  #development = process.env.NODE_ENV === 'development';
  #subscriber: Promise<RedisClient> | undefined;
  #closed = false;
  readonly #signingKey: Uint8Array | undefined;
  readonly #maxSignatureAge: number;

  constructor(options: RedisPubSubOptions = {}) {
    if (options.signingKey !== undefined) {
      const key =
        typeof options.signingKey === 'string'
          ? new TextEncoder().encode(options.signingKey)
          : options.signingKey;
      if (key.byteLength < 32) {
        throw new HttpConfigError('RedisPubSub signingKey must be at least 32 bytes.');
      }
      this.#signingKey = key;
    }
    const maxAge = options.maxSignatureAge ?? 60_000;
    if (!Number.isInteger(maxAge) || maxAge < 1) {
      throw new HttpConfigError(
        `RedisPubSub maxSignatureAge must be a positive integer (ms); got ${String(maxAge)}.`,
      );
    }
    this.#maxSignatureAge = maxAge;
    this.#owned = options.client === undefined;
    this.#publisher = options.client ?? new RedisClient(options.url);
    this.#prefix = options.prefix ?? 'hpmws:gql:';
    this.#explicitLogger = options.logger !== undefined;
    this.#logger = options.logger ?? new ConsoleLogger('hpmws:graphql');
    const url =
      options.url ??
      (options.client === undefined
        ? process.env.REDIS_URL || process.env.VALKEY_URL || undefined
        : undefined);
    const remote = plaintextRemoteHost(url);
    if (remote !== undefined) {
      this.#logger.warn(
        `RedisPubSub connects to ${remote} over plain redis://, so events and credentials ` +
          'cross the network unencrypted. Use rediss:// (TLS) with an ACL user.',
      );
    }
  }

  /**
   * @internal GraphQLModule passes the application LOGGER (unless one was configured) and its
   * development flag.
   */
  useLogger(logger: Logger, development?: boolean): void {
    if (!this.#explicitLogger) this.#logger = logger;
    if (development !== undefined) this.#development = development;
  }

  /** Logs through logError(): a summary outside development, the redacted error in it. */
  #logError(message: string, error: unknown, level: 'error' | 'warn' = 'error'): void {
    logError({ logger: this.#logger, development: this.#development }, message, error, level);
  }

  subscribe(
    topic: string,
    callback: (payload: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void {
    if (this.#closed) throw new Error('RedisPubSub is closed.');
    let listeners = this.#topics.get(topic);
    if (!listeners) {
      const created = new Set<Listener>();
      this.#topics.set(topic, created);
      this.#enqueue(topic, () => this.#redisSubscribe(topic, created));
      listeners = created;
    }
    const listener: Listener = { callback, onError };
    listeners.add(listener);
    const own = listeners;
    return () => {
      if (!own.delete(listener) || own.size > 0 || this.#topics.get(topic) !== own) return;
      this.#topics.delete(topic);
      this.#enqueue(topic, () => this.#redisUnsubscribe(topic, own));
    };
  }

  /**
   * Publishes `payload` (as JSON) and never rejects: a failure is logged, and the event is lost.
   * Use publishOrThrow() when the caller must know.
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    try {
      await this.publishOrThrow(topic, payload);
    } catch (error) {
      this.#logError(`RedisPubSub failed to publish to ${JSON.stringify(topic)}`, error);
    }
  }

  /** Like publish(), but rejects when Redis did not accept the message. */
  async publishOrThrow(topic: string, payload: unknown): Promise<void> {
    const json = JSON.stringify(payload);
    let message = json;
    if (this.#signingKey) {
      const ts = String(Date.now());
      message = `${this.#sign(topic, ts, json)}.${ts}.${json}`;
    }
    await this.#publisher.publish(this.#prefix + topic, message);
  }

  #sign(topic: string, ts: string, json: string): string {
    return createHmac('sha256', this.#signingKey!)
      .update(`${this.#prefix}${topic}\0${ts}\0${json}`)
      .digest('hex');
  }

  /** The payload JSON of a correctly signed, fresh message, or undefined. */
  #verified(topic: string, message: string): string | undefined {
    if (message[SIGNATURE_LENGTH] !== '.') return undefined;
    const dot = message.indexOf('.', SIGNATURE_LENGTH + 1);
    if (dot < 0) return undefined;
    const ts = message.slice(SIGNATURE_LENGTH + 1, dot);
    if (!/^\d{1,16}$/.test(ts)) return undefined;
    const age = Date.now() - Number(ts);
    if (age > this.#maxSignatureAge || age < -MAX_FUTURE_SKEW) return undefined;
    const json = message.slice(dot + 1);
    const given = Buffer.from(message.slice(0, SIGNATURE_LENGTH), 'utf8');
    const expected = Buffer.from(this.#sign(topic, ts, json), 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected) ? json : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#topics.clear();
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    const client = await subscriber?.catch(() => undefined);
    if (client) {
      // Bun keeps the process alive after closing a client that is still in subscriber mode.
      // unsubscribe() throws synchronously when the client is not in subscriber mode.
      try {
        if (client.connected) await client.unsubscribe();
      } catch {
        // Nothing was subscribed, or the connection is gone: close() below is enough.
      }
      client.close();
    }
    if (this.#owned) this.#publisher.close();
  }

  /** Runs `op` after the topic's earlier Redis calls; `op` handles its own errors. */
  #enqueue(topic: string, op: () => Promise<void>): void {
    const next = (this.#redisOps.get(topic) ?? Promise.resolve()).then(op);
    this.#redisOps.set(topic, next);
    void next.then(() => {
      if (this.#redisOps.get(topic) === next) this.#redisOps.delete(topic);
    });
  }

  async #redisUnsubscribe(topic: string, listeners: Set<Listener>): Promise<void> {
    // Nothing to undo when the SUBSCRIBE failed.
    const subscriber = this.#subscriber;
    if (this.#closed || !subscriber || !this.#subscribed.delete(listeners)) return;
    try {
      await (await subscriber).unsubscribe(this.#prefix + topic);
    } catch (error) {
      if (!this.#closed)
        this.#logError(
          `RedisPubSub failed to unsubscribe from ${JSON.stringify(topic)}`,
          error,
          'warn',
        );
    }
  }

  #subscriberClient(): Promise<RedisClient> {
    if (!this.#subscriber) {
      const pending = this.#publisher.duplicate();
      this.#subscriber = pending;
      // A failed connection is not cached: the next subscribe() tries again.
      pending.catch(() => {
        if (this.#subscriber === pending) this.#subscriber = undefined;
      });
    }
    return this.#subscriber;
  }

  async #redisSubscribe(topic: string, listeners: Set<Listener>): Promise<void> {
    if (this.#closed) return;
    try {
      const subscriber = await this.#subscriberClient();
      await subscriber.subscribe(this.#prefix + topic, (message) => {
        let json: string | undefined = message;
        if (this.#signingKey) {
          json = this.#verified(topic, message);
          if (json === undefined) {
            this.#logger.warn(
              `RedisPubSub dropped a message on ${JSON.stringify(topic)} without a valid signature`,
            );
            return;
          }
        }
        let payload: unknown;
        try {
          payload = JSON.parse(json);
        } catch {
          this.#logger.warn(`RedisPubSub dropped a non-JSON message on ${JSON.stringify(topic)}`);
          return;
        }
        for (const listener of this.#topics.get(topic) ?? []) {
          try {
            listener.callback(payload);
          } catch (error) {
            this.#logError(`RedisPubSub listener for ${JSON.stringify(topic)} threw`, error);
          }
        }
      });
      this.#subscribed.add(listeners);
    } catch (error) {
      if (this.#closed) return;
      this.#logError(`RedisPubSub failed to subscribe to ${JSON.stringify(topic)}`, error);
      if (this.#topics.get(topic) === listeners) this.#topics.delete(topic);
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of listeners) listener.onError?.(failure);
    }
  }
}
