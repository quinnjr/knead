import { InjectionToken } from '@hpmws/core';
import type { PubSubEngine } from '@leaven-graphql/ws';

/** The PubSubEngine used by @Subscription resolvers: `inject(PUBSUB).publish(topic, payload)`. */
export const PUBSUB = new InjectionToken<PubSubEngine>('PUBSUB');

/** Events buffered per subscriber before the oldest is dropped (slow consumers). */
export const MAX_QUEUED_EVENTS = 1000;

/**
 * An async iterator over `topics` on any PubSubEngine. `filter` runs per event; `return()`
 * unsubscribes from every topic.
 */
export function eventIterator<T>(
  engine: PubSubEngine,
  topics: readonly string[],
  filter?: (payload: T) => boolean | Promise<boolean>,
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const waiting: ((result: IteratorResult<T>) => void)[] = [];
  let done = false;
  const push = (payload: unknown) => {
    if (done) return;
    const waiter = waiting.shift();
    if (waiter) waiter({ value: payload as T, done: false });
    else {
      if (queue.length >= MAX_QUEUED_EVENTS) queue.shift();
      queue.push(payload as T);
    }
  };
  const unsubscribes = topics.map((topic) => engine.subscribe(topic, push));
  const finish = () => {
    if (done) return;
    done = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
    queue.length = 0;
  };
  const pull = (): Promise<IteratorResult<T>> => {
    if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
    if (done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => waiting.push(resolve));
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      for (;;) {
        const result = await pull();
        if (result.done || !filter || (await filter(result.value))) return result;
      }
    },
    async return() {
      finish();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      finish();
      throw error;
    },
  };
}
