// TC39 decorator metadata reads Symbol.metadata when a decorated class is defined.
// Bun 1.4 does not ship it natively, so this must run before any decorated class.
if (typeof Symbol.metadata !== 'symbol') {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol.for('Symbol.metadata'),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export {};
