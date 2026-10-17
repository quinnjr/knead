import { inject, KneadError } from '@knead-js/core';
import {
  assertIsolationLevel,
  assertPropagation,
  type RunOptions,
  TransactionHost,
} from './transaction-host.js';

const HOST = Symbol('knead:prisma:host');

type WithHost = { [HOST]?: TransactionHost };

/**
 * Runs the decorated async method inside `TransactionHost.run`. The class must be built by the
 * DI container; constructing it with `new` throws `InjectionContextError`. Static methods and
 * unknown `propagation` or `isolationLevel` values are a KneadError when the class is defined.
 */
export function Transactional(options?: RunOptions) {
  assertPropagation(options?.propagation);
  assertIsolationLevel(options?.isolationLevel);
  return <This, A extends unknown[], R>(
    target: (this: This, ...args: A) => Promise<R>,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: A) => Promise<R>>,
  ): ((this: This, ...args: A) => Promise<R>) => {
    if (context.static) throw new KneadError('@Transactional cannot decorate static methods');
    const name = String(context.name);
    context.addInitializer(function (this: This) {
      (this as unknown as WithHost)[HOST] = inject(TransactionHost);
    });
    return function (this: This, ...args: A): Promise<R> {
      const host = (this as unknown as WithHost)[HOST];
      if (!host) {
        return Promise.reject(
          new KneadError(
            `@Transactional ${name}(): no TransactionHost on this instance. The decorator needs ` +
              'Bun >= 1.4.3 (older Bun can skip its initializer) and an instance built by the DI container.',
          ),
        );
      }
      return host.run(() => target.apply(this, args), options);
    };
  };
}
