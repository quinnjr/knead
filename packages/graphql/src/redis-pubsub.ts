import type { PubSubEngine } from '@leaven-graphql/ws';
import { RedisClient } from 'bun';

export interface RedisPubSubOptions {
  /** Publisher connection (not closed by close()). The subscriber is always a dedicated duplicate. */
  client?: RedisClient;
  /** Connection URL when no client is given (default: Bun's REDIS_URL / localhost). */
  url?: string;
  /** Channel prefix. Default 'hpmws:gql:'. */
  prefix?: string;
}

type Listener = (payload: unknown) => void;

/**
 * PubSubEngine on Bun.redis for multi-instance deployments. Payloads are JSON. Redis requires a
 * connection in subscriber mode to do nothing else, so subscriptions use a dedicated connection.
 */
export class RedisPubSub implements PubSubEngine {
  readonly #publisher: RedisClient;
  readonly #owned: boolean;
  readonly #prefix: string;
  readonly #listeners = new Map<string, Set<Listener>>();
  #subscriber: Promise<RedisClient> | undefined;
  #closed = false;

  constructor(options: RedisPubSubOptions = {}) {
    this.#owned = options.client === undefined;
    this.#publisher = options.client ?? new RedisClient(options.url);
    this.#prefix = options.prefix ?? 'hpmws:gql:';
  }

  subscribe(topic: string, callback: (payload: unknown) => void): () => void {
    if (this.#closed) throw new Error('RedisPubSub is closed.');
    let set = this.#listeners.get(topic);
    if (!set) {
      set = new Set();
      this.#listeners.set(topic, set);
      void this.#redisSubscribe(topic);
    }
    const listener: Listener = (payload) => callback(payload);
    set.add(listener);
    return () => {
      const current = this.#listeners.get(topic);
      if (!current?.delete(listener) || current.size > 0) return;
      this.#listeners.delete(topic);
      void this.#subscriberClient()
        .then((s) => s.unsubscribe(this.#prefix + topic))
        .catch(() => {});
    };
  }

  /** Resolves once Redis accepted the message (fire-and-forget callers may ignore it). */
  async publish(topic: string, payload: unknown): Promise<void> {
    await this.#publisher.publish(this.#prefix + topic, JSON.stringify(payload));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    if (subscriber) (await subscriber.catch(() => undefined))?.close();
    if (this.#owned) this.#publisher.close();
  }

  #subscriberClient(): Promise<RedisClient> {
    this.#subscriber ??= this.#publisher.duplicate();
    return this.#subscriber;
  }

  async #redisSubscribe(topic: string): Promise<void> {
    try {
      const subscriber = await this.#subscriberClient();
      await subscriber.subscribe(this.#prefix + topic, (message) => {
        let payload: unknown;
        try {
          payload = JSON.parse(message);
        } catch {
          return;
        }
        for (const listener of this.#listeners.get(topic) ?? []) {
          try {
            listener(payload);
          } catch (error) {
            console.error('RedisPubSub listener threw', error);
          }
        }
      });
    } catch (error) {
      console.error(`RedisPubSub failed to subscribe to ${topic}`, error);
    }
  }
}
