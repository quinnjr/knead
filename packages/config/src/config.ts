const INSPECT = Symbol.for('nodejs.util.inspect.custom');

function deepFreeze<V>(value: V): V {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validated configuration. Never reveals values through JSON or inspection. */
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
