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

/** Objects already frozen all the way down, so a payload shared by many subscribers is walked once. */
const deeplyFrozen = new WeakSet<object>();

/**
 * Freezes `value` and every object reachable through its own properties (typed arrays and
 * buffers are skipped: they cannot be frozen), and returns it. Event payloads are shared by
 * every subscriber, so one resolver must not be able to change what the others receive.
 */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item !== 'object' || item === null) continue;
    if (deeplyFrozen.has(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) continue;
    Object.freeze(item);
    deeplyFrozen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor && 'value' in descriptor) stack.push(descriptor.value);
    }
  }
  return value;
}

/**
 * An async iterator over `topics` on any PubSubEngine. Payloads are deep-frozen when they
 * arrive (deepFreeze), so they are immutable for resolvers. `filter` runs per event; `return()`
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
    deepFreeze(payload);
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
