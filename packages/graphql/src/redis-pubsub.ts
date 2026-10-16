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
      listeners = new Set();
      this.#topics.set(topic, listeners);
      void this.#redisSubscribe(topic, listeners);
    }
    const listener: Listener = { callback, onError };
    listeners.add(listener);
    const own = listeners;
    return () => {
      if (!own.delete(listener) || own.size > 0 || this.#topics.get(topic) !== own) return;
      this.#topics.delete(topic);
      const subscriber = this.#subscriber;
      if (!subscriber) return;
      void subscriber
        .then((s) => s.unsubscribe(this.#prefix + topic))
        .catch((error) =>
          this.#logger.warn(`RedisPubSub failed to unsubscribe from ${topic}`, error),
        );
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
    } catch (error) {
      this.#logger.error(`RedisPubSub failed to subscribe to ${topic}`, error);
      if (this.#topics.get(topic) === listeners) this.#topics.delete(topic);
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of listeners) listener.onError?.(failure);
    }
  }
}
