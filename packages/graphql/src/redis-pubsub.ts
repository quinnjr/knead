import { ConsoleLogger, type Logger } from '@hpmws/http';
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
  #subscriber: Promise<RedisClient> | undefined;
  #closed = false;

  constructor(options: RedisPubSubOptions = {}) {
    this.#owned = options.client === undefined;
    this.#publisher = options.client ?? new RedisClient(options.url);
    this.#prefix = options.prefix ?? 'hpmws:gql:';
    this.#explicitLogger = options.logger !== undefined;
    this.#logger = options.logger ?? new ConsoleLogger('hpmws:graphql');
  }

  /** @internal GraphQLModule passes the application LOGGER unless one was configured. */
  useLogger(logger: Logger): void {
    if (!this.#explicitLogger) this.#logger = logger;
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

  /** Resolves once Redis accepted the message (fire-and-forget callers may ignore it). */
  async publish(topic: string, payload: unknown): Promise<void> {
    await this.#publisher.publish(this.#prefix + topic, JSON.stringify(payload));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#topics.clear();
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    if (subscriber) (await subscriber.catch(() => undefined))?.close();
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
        this.#logger.warn(`RedisPubSub failed to unsubscribe from ${topic}`, error);
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
        let payload: unknown;
        try {
          payload = JSON.parse(message);
        } catch {
          this.#logger.warn(`RedisPubSub dropped a non-JSON message on ${topic}`);
          return;
        }
        for (const listener of this.#topics.get(topic) ?? []) {
          try {
            listener.callback(payload);
          } catch (error) {
            this.#logger.error(`RedisPubSub listener for ${topic} threw`, error);
          }
        }
      });
      this.#subscribed.add(listeners);
    } catch (error) {
      if (this.#closed) return;
      this.#logger.error(`RedisPubSub failed to subscribe to ${topic}`, error);
      if (this.#topics.get(topic) === listeners) this.#topics.delete(topic);
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of listeners) listener.onError?.(failure);
    }
  }
}
