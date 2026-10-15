import './polyfill.js';

/** A typed key for decorator metadata. Each instance owns a unique symbol. */
export class MetadataKey<T> {
  declare readonly __type: T;
  readonly symbol: symbol;

  constructor(readonly description: string) {
    this.symbol = Symbol(description);
  }
}

type Bag = Record<PropertyKey, unknown>;
type MethodBags = Record<PropertyKey, Bag>;

const METHODS = Symbol('hpmws:methods');

function bagOf(target: object): Bag | undefined {
  return (target as { [Symbol.metadata]?: Bag | null })[Symbol.metadata] ?? undefined;
}

function copyOnWriteArray<T>(bag: Bag, symbol: symbol): T[] {
  const current = bag[symbol] as T[] | undefined;
  const own = Object.hasOwn(bag, symbol) && current ? current : [...(current ?? [])];
  bag[symbol] = own;
  return own;
}

export function setMetadata<T>(meta: DecoratorMetadataObject, key: MetadataKey<T>, value: T): void {
  meta[key.symbol] = value;
}

/** Appends to a list without mutating a list inherited from a parent class. */
export function appendMetadata<T>(
  meta: DecoratorMetadataObject,
  key: MetadataKey<T[]>,
  ...items: T[]
): void {
  copyOnWriteArray<T>(meta, key.symbol).push(...items);
}

export function readMetadata<T>(meta: DecoratorMetadataObject, key: MetadataKey<T>): T | undefined {
  return meta[key.symbol] as T | undefined;
}

export function getMetadata<T>(target: object, key: MetadataKey<T>): T | undefined {
  return bagOf(target)?.[key.symbol] as T | undefined;
}

export function getOwnMetadata<T>(target: object, key: MetadataKey<T>): T | undefined {
  // A subclass with no decorators of its own inherits its parent's bag through
  // the constructor prototype chain, so require the bag itself to be own.
  if (!Object.hasOwn(target, Symbol.metadata)) return undefined;
  const bag = bagOf(target);
  return bag && Object.hasOwn(bag, key.symbol) ? (bag[key.symbol] as T) : undefined;
}

function ownMethodBag(meta: DecoratorMetadataObject, method: PropertyKey): Bag {
  const inherited = meta[METHODS] as MethodBags | undefined;
  const methods: MethodBags =
    Object.hasOwn(meta, METHODS) && inherited ? inherited : Object.create(inherited ?? null);
  meta[METHODS] = methods;
  if (!Object.hasOwn(methods, method)) {
    methods[method] = Object.create((methods[method] as Bag | undefined) ?? null) as Bag;
  }
  return methods[method] as Bag;
}

export function setMethodMetadata<T>(
  meta: DecoratorMetadataObject,
  method: PropertyKey,
  key: MetadataKey<T>,
  value: T,
): void {
  ownMethodBag(meta, method)[key.symbol] = value;
}

export function appendMethodMetadata<T>(
  meta: DecoratorMetadataObject,
  method: PropertyKey,
  key: MetadataKey<T[]>,
  ...items: T[]
): void {
  copyOnWriteArray<T>(ownMethodBag(meta, method), key.symbol).push(...items);
}

export function readMethodMetadata<T>(
  meta: DecoratorMetadataObject,
  method: PropertyKey,
  key: MetadataKey<T>,
): T | undefined {
  const methods = meta[METHODS] as MethodBags | undefined;
  return methods?.[method]?.[key.symbol] as T | undefined;
}

export function getMethodMetadata<T>(
  target: object,
  method: PropertyKey,
  key: MetadataKey<T>,
): T | undefined {
  const methods = bagOf(target)?.[METHODS] as MethodBags | undefined;
  return methods?.[method]?.[key.symbol] as T | undefined;
}
