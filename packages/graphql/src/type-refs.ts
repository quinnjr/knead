import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLEnumValueConfig,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  type GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql';

/** Phantom key carrying the TypeScript type of a handle. Never present at runtime. */
declare const TS_TYPE: unique symbol;

export type Class<T = unknown> = abstract new (...args: any[]) => T;

/**
 * A typed reference to a non-class GraphQL type. The required `__kind` brand keeps classes from
 * matching handles structurally (a class has `name`, so without the brand it would match).
 */
export interface TypeHandle<T, K extends HandleKind = HandleKind> {
  readonly __kind: K;
  readonly name: string;
  readonly [TS_TYPE]?: T;
}

export type HandleKind = 'scalar' | 'enum' | 'union';

export interface ScalarHandle<T> extends TypeHandle<T, 'scalar'> {
  readonly graphql: GraphQLScalarType;
}

export interface EnumHandle<T> extends TypeHandle<T, 'enum'> {
  readonly graphql: GraphQLEnumType;
}

export interface UnionHandle<T> extends TypeHandle<T, 'union'> {
  readonly description: string | undefined;
  readonly types: () => readonly Class[];
  readonly resolveType:
    | ((value: T, info: GraphQLResolveInfo) => Class | string | undefined)
    | undefined;
}

/** Anything a type thunk may return for a single (non-list) type. */
export type TypeRef =
  | Class
  | TypeHandle<unknown>
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor;

/** What a type thunk returns: a type, or `[type]` for a list. */
export type TypeThunkResult = TypeRef | readonly [TypeRef];

/** The TypeScript type a single type reference maps to. */
export type TsOf<R> = R extends StringConstructor
  ? string
  : R extends NumberConstructor
    ? number
    : R extends BooleanConstructor
      ? boolean
      : R extends { readonly __kind: HandleKind; readonly [TS_TYPE]?: infer T }
        ? T
        : R extends abstract new (
              ...args: any[]
            ) => infer I
          ? I
          : never;

/** `true` makes a single value nullable; lists choose which level is nullable. */
export type Nullable = boolean | 'items' | 'list' | 'both';

type Nil = null | undefined;
type ListOf<E, RO extends boolean> = RO extends true ? readonly E[] : E[];

/**
 * The TypeScript type of a field/return declared as `() => R` with `nullable: Nl`. `RO` selects
 * readonly arrays, so `string[]` and `readonly string[]` fields are both accepted.
 */
export type OutType<R, Nl, RO extends boolean = false> = R extends readonly [infer E]
  ? Nl extends 'items'
    ? ListOf<TsOf<E> | Nil, RO>
    : Nl extends 'list' | true
      ? ListOf<TsOf<E>, RO> | Nil
      : Nl extends 'both'
        ? ListOf<TsOf<E> | Nil, RO> | Nil
        : ListOf<TsOf<E>, RO>
  : Nl extends true
    ? TsOf<R> | Nil
    : TsOf<R>;

function scalar<T>(graphql: GraphQLScalarType): ScalarHandle<T> {
  return Object.freeze({ __kind: 'scalar', name: graphql.name, graphql }) as ScalarHandle<T>;
}

export const ID: ScalarHandle<string> = scalar(GraphQLID);
export const Int: ScalarHandle<number> = scalar(GraphQLInt);
export const Float: ScalarHandle<number> = scalar(GraphQLFloat);

/** Typed handle for a custom scalar: `defineScalar<Date>(DateTimeScalar)`. */
export function defineScalar<T>(graphql: GraphQLScalarType<T, unknown>): ScalarHandle<T> {
  if (!(graphql instanceof GraphQLScalarType)) {
    throw new TypeError('defineScalar() expects a GraphQLScalarType from the "graphql" package.');
  }
  return scalar<T>(graphql as GraphQLScalarType);
}

export interface EnumConfig<E> {
  name: string;
  description?: string;
  valuesConfig?: { [K in keyof E]?: Omit<GraphQLEnumValueConfig, 'value'> };
}

/**
 * GraphQL enum from a TypeScript enum or a const object. Names are the keys; values are the
 * object's values (numeric enums' reverse-mapping keys are skipped).
 */
export function defineEnum<const E extends Record<string, string | number>>(
  values: E,
  config: EnumConfig<E>,
): EnumHandle<E[keyof E]> {
  const entries = Object.entries(values).filter(([key]) => Number.isNaN(Number(key)));
  if (entries.length === 0) throw new TypeError(`Enum ${config.name} has no values.`);
  const graphql = new GraphQLEnumType({
    name: config.name,
    description: config.description,
    values: Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        { ...(config.valuesConfig?.[key as keyof E] ?? {}), value },
      ]),
    ),
  });
  return Object.freeze({ __kind: 'enum', name: config.name, graphql }) as EnumHandle<E[keyof E]>;
}

export interface UnionConfig<T extends readonly Class[]> {
  name: string;
  description?: string;
  types: () => T;
  /** Defaults to an `instanceof` check over `types`, then `value.__typename`. */
  resolveType?: (value: InstanceOfUnion<T>, info: GraphQLResolveInfo) => Class | string | undefined;
}

type InstanceOfUnion<T extends readonly Class[]> = T[number] extends abstract new (
  ...args: any[]
) => infer I
  ? I
  : never;

export function defineUnion<const T extends readonly Class[]>(
  config: UnionConfig<T>,
): UnionHandle<InstanceOfUnion<T>> {
  return Object.freeze({
    __kind: 'union',
    name: config.name,
    description: config.description,
    types: config.types,
    resolveType: config.resolveType,
  }) as unknown as UnionHandle<InstanceOfUnion<T>>;
}

export function isHandle(
  value: unknown,
): value is ScalarHandle<unknown> | EnumHandle<unknown> | UnionHandle<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __kind?: unknown }).__kind === 'string'
  );
}

/** Built-in scalars for the global constructors `String`, `Number` and `Boolean`. */
export const GLOBAL_SCALARS: ReadonlyMap<unknown, GraphQLScalarType> = new Map<
  unknown,
  GraphQLScalarType
>([
  [String, GraphQLString],
  [Number, GraphQLFloat],
  [Boolean, GraphQLBoolean],
]);
