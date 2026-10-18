const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Freezes `value` and, recursively, the values of its own data properties, string and symbol keys
 * alike (cycles are handled). Plain objects, arrays and class instances end up immutable; the
 * internal contents of a Map, Set or Date (for example from a schema transform) are not
 * properties, so they stay mutable through the object's own methods. Typed arrays, Buffers,
 * DataViews and ArrayBuffers are left as they are (a typed array with elements cannot be
 * frozen), so their bytes stay mutable too.
 */
function deepFreeze<V>(value: V, seen = new WeakSet<object>()): V {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return value;
}

/**
 * Validated configuration, deep-frozen (see deepFreeze: Map, Set and Date contents and binary
 * data are not frozen).
 * Never reveals values through JSON or inspection.
 */
export class Config<T> {
  readonly #data: Readonly<T>;

  constructor(data: T) {
    this.#data = deepFreeze(data);
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.#data[key];
  }

  all(): Readonly<T> {
    return this.#data;
  }

  toJSON(): Record<keyof T, '[redacted]'> {
    const out = {} as Record<keyof T, '[redacted]'>;
    for (const key of Object.keys(this.#data as object) as (keyof T)[]) out[key] = '[redacted]';
    return out;
  }

  [INSPECT](): string {
    return `Config ${JSON.stringify(this.toJSON())}`;
  }
}
