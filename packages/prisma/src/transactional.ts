import { inject } from '@knead-js/core';
import { type RunOptions, TransactionHost } from './transaction-host.js';

const HOST = Symbol('knead:prisma:host');

type WithHost = { [HOST]: TransactionHost };

/**
 * Runs the decorated async method inside `TransactionHost.run`. The class must be built by the
 * DI container; constructing it with `new` throws `InjectionContextError`.
 */
export function Transactional(options?: RunOptions) {
  return <This, A extends unknown[], R>(
    target: (this: This, ...args: A) => Promise<R>,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: A) => Promise<R>>,
  ): ((this: This, ...args: A) => Promise<R>) => {
    context.addInitializer(function (this: This) {
      (this as unknown as WithHost)[HOST] = inject(TransactionHost);
    });
    return function (this: This, ...args: A): Promise<R> {
      return (this as unknown as WithHost)[HOST].run(() => target.apply(this, args), options);
    };
  };
}
