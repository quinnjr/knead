import { InjectionToken } from '@hpmws/core';
import { type Logger, redactCredentials, redactValue, summarizeError } from '@hpmws/http';
import type { PubSubEngine } from '@leaven-graphql/ws';

/** The PubSubEngine used by @Subscription resolvers: `inject(PUBSUB).publish(topic, payload)`. */
export const PUBSUB = new InjectionToken<PubSubEngine>('PUBSUB');

/** Events buffered per subscriber before the oldest is dropped (slow consumers). */
export const MAX_QUEUED_EVENTS = 1000;

/**
 * Engines may accept a third `onError` argument to report that a subscription can no longer
 * deliver events (RedisPubSub does); Leaven's in-memory PubSub ignores it.
 */
type SubscribeWithError = (
  topic: string,
  callback: (payload: unknown) => void,
  onError?: (error: Error) => void,
) => () => void;

export interface EventIteratorOptions {
  /** Called each time a full queue drops its oldest event. */
  onDrop?: () => void;
}

/** Thrown from next() when the engine reports a failure; the cause is not exposed to clients. */
export class EventSourceError extends Error {
  constructor(cause: unknown) {
    super('Subscription event source failed.', { cause });
    this.name = 'EventSourceError';
  }
}

/**
 * An async iterator over `topics` on any PubSubEngine. `filter` runs per event; `return()`
 * unsubscribes from every topic.
 */
export function eventIterator<T>(
  engine: PubSubEngine,
  topics: readonly string[],
  filter?: (payload: T) => boolean | Promise<boolean>,
  options: EventIteratorOptions = {},
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const waiting: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let done = false;
  let failure: EventSourceError | undefined;
  const push = (payload: unknown) => {
    if (done) return;
    const waiter = waiting.shift();
    if (waiter) waiter.resolve({ value: payload as T, done: false });
    else {
      if (queue.length >= MAX_QUEUED_EVENTS) {
        queue.shift();
        options.onDrop?.();
      }
      queue.push(payload as T);
    }
  };
  const fail = (error: Error) => {
    if (done || failure) return;
    failure = new EventSourceError(error);
    for (const waiter of waiting.splice(0)) waiter.reject(failure);
  };
  const subscribe = engine.subscribe.bind(engine) as SubscribeWithError;
  const unsubscribes = topics.map((topic) => subscribe(topic, push, fail));
  const finish = () => {
    if (done) return;
    done = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const waiter of waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
    queue.length = 0;
  };
  const pull = (): Promise<IteratorResult<T>> => {
    if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
    if (done) return Promise.resolve({ value: undefined, done: true });
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
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

/**
 * Adapts an hpmws `Logger` to the logger Leaven's WebSocket transport and in-memory `PubSub`
 * accept, so their diagnostics go through `LOGGER` instead of `console`. Arguments are redacted
 * whatever LOGGER is configured; outside development an Error argument is reduced to
 * `Name: message` (summarizeError), without its stack, cause or properties.
 */
export function leavenLogger(
  logger: Logger,
  development = false,
): {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
} {
  const prepare = (args: unknown[]): [string, unknown[]] => {
    const [message, meta] =
      typeof args[0] === 'string' ? [args[0], args.slice(1)] : ['Leaven', args];
    const safe = meta.map((value) =>
      !development && value instanceof Error ? summarizeError(value) : redactValue(value),
    );
    return [redactCredentials(message), safe];
  };
  return {
    error: (...args) => {
      const [message, meta] = prepare(args);
      logger.error(message, ...meta);
    },
    warn: (...args) => {
      const [message, meta] = prepare(args);
      logger.warn(message, ...meta);
    },
  };
}
