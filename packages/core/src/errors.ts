import { tokenName } from './tokens.js';

export class KneadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InjectionContextError extends KneadError {
  constructor(token: unknown) {
    super(
      `inject(${tokenName(token)}) was called outside an injection context. inject() only works ` +
        'synchronously inside field initializers, constructors and provider factories; ' +
        'call it before the first await.',
    );
  }
}

export class NoProviderError extends KneadError {}

export class CircularDependencyError extends KneadError {
  constructor(readonly path: string[]) {
    super(`Circular dependency detected: ${path.join(' → ')}`);
  }
}

export class ModuleDefinitionError extends KneadError {}

export class ProviderConfigError extends KneadError {}

/** @internal Thrown when a synchronous resolution hits an async factory that has not settled. */
export class AsyncProviderPendingError extends KneadError {
  constructor(
    readonly record: unknown,
    name: string,
  ) {
    super(`Async provider ${name} is not resolved yet.`);
  }
}
