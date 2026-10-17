import { getMetadata, getOwnMetadata } from '@knead-js/core';
import {
  defaultFieldResolver,
  type GraphQLArgumentConfig,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldResolver,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInterfaceType,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  GraphQLSchema,
  GraphQLUnionType,
  lexicographicSortSchema,
  printSchema,
  specifiedScalarTypes,
  validateSchema,
} from 'graphql';
import { SchemaBuildError } from './errors.js';
import type { FieldGuardSet } from './field-guards.js';
import {
  type ArgMap,
  type ArgSpec,
  FIELDS,
  type FieldDefinition,
  TYPE_DEF,
  type TypeDefinition,
} from './metadata.js';
import {
  type Class,
  GLOBAL_SCALARS,
  isHandle,
  type Nullable,
  type TypeThunkResult,
  type UnionHandle,
} from './type-refs.js';

/** One field contributed by a resolver method (root operation field or @ResolveField). */
export interface FieldSpec {
  name: string;
  /** `ResolverClass.method`, used in error messages. */
  owner: string;
  type: () => TypeThunkResult;
  nullable?: Nullable | undefined;
  description?: string | undefined;
  deprecationReason?: string | undefined;
  complexity?: number | undefined;
  args?: ArgMap | Class | undefined;
  resolve?: GraphQLFieldResolver<any, any> | undefined;
  subscribe?: GraphQLFieldResolver<any, any> | undefined;
}

export interface SchemaInput {
  query: readonly FieldSpec[];
  mutation: readonly FieldSpec[];
  subscription: readonly FieldSpec[];
  /** @ResolveField specs keyed by the @Resolver(() => T) class. */
  typeFields: ReadonlyMap<Class, readonly FieldSpec[]>;
  /** Built even when unreachable (orphanedTypes and resolver target types). */
  types: readonly Class[];
  /** The field guards of an @ObjectType class (`@UseFieldGuards`), or undefined when it has none. */
  fieldGuards?: (cls: Class) => FieldGuardSet | undefined;
  /** Wraps a field resolver of `cls` in its field guards; called only when fieldGuards(cls) is set. */
  wrapField?: (
    cls: Class,
    resolve: GraphQLFieldResolver<any, any>,
  ) => GraphQLFieldResolver<any, any>;
}

/** Fields of a decorated class, including inherited ones; a subclass redeclaration wins. */
export function collectFields(cls: Class): FieldDefinition[] {
  const byKey = new Map<string, FieldDefinition>();
  for (const field of getMetadata(cls, FIELDS) ?? []) byKey.set(field.key, field);
  return [...byKey.values()];
}

/** The argument names declared by an inline map or an @ArgsType class. */
export function argNames(args: ArgMap | Class | undefined): string[] {
  if (args === undefined) return [];
  if (typeof args === 'function') return collectFields(args).map((f) => f.key);
  return Object.keys(args);
}

function guessName(thunk: () => unknown): string | undefined {
  return /=>\s*\[?\s*([A-Za-z_$][\w$]*)/.exec(String(thunk))?.[1];
}

function isArgObject(spec: ArgSpec): spec is Exclude<ArgSpec, TypeThunkResult> {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    !Array.isArray(spec) &&
    !isHandle(spec) &&
    typeof (spec as { type?: unknown }).type === 'function'
  );
}

function typeName(ref: unknown): string {
  return typeof ref === 'function' ? ref.name || '<anonymous class>' : String(ref);
}

/** printSchema over a lexicographically sorted copy, so the SDL is stable across runs. */
export function printSortedSchema(schema: GraphQLSchema): string {
  return `${printSchema(lexicographicSortSchema(schema))}\n`;
}

export class SchemaBuilder {
  readonly #outputs = new Map<Class, GraphQLObjectType | GraphQLInterfaceType>();
  readonly #inputs = new Map<Class, GraphQLInputObjectType>();
  readonly #unions = new Map<UnionHandle<unknown>, GraphQLUnionType>();
  /** GraphQL name → [identity, label] of the class or type that claimed it. */
  readonly #names = new Map<string, [unknown, string]>();
  readonly #objectClasses = new Map<Class, TypeDefinition>();

  constructor(private readonly input: SchemaInput) {
    for (const scalar of specifiedScalarTypes) this.#claim(scalar.name, scalar, scalar.name);
    for (const root of ['Query', 'Mutation', 'Subscription']) {
      this.#claim(root, 'root', `the ${root} root type`);
    }
  }

  build(): GraphQLSchema {
    const { query, mutation, subscription } = this.input;
    if (query.length === 0) {
      throw new SchemaBuildError(
        'No @Query() resolvers found. A GraphQL schema needs at least one query; make sure ' +
          'your @Resolver() classes are listed in the providers of an imported module.',
      );
    }
    const schema = new GraphQLSchema({
      query: this.#root('Query', query),
      mutation: mutation.length > 0 ? this.#root('Mutation', mutation) : undefined,
      subscription: subscription.length > 0 ? this.#root('Subscription', subscription) : undefined,
      types: this.input.types.map((cls) => this.#namedType(cls, 'orphanedTypes')),
    });
    const errors = validateSchema(schema);
    if (errors.length > 0) {
      throw new SchemaBuildError(
        `Invalid GraphQL schema:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`,
      );
    }
    return schema;
  }

  #claim(name: string, identity: unknown, label: string): void {
    const existing = this.#names.get(name);
    if (!existing) {
      this.#names.set(name, [identity, label]);
      return;
    }
    if (existing[0] !== identity) {
      throw new SchemaBuildError(
        `Duplicate GraphQL type name "${name}": ${existing[1]} and ${label}.`,
      );
    }
  }

  #root(name: string, specs: readonly FieldSpec[]): GraphQLObjectType {
    const owners = new Map<string, string>();
    for (const spec of specs) {
      const previous = owners.get(spec.name);
      if (previous) {
        throw new SchemaBuildError(
          `Duplicate ${name} field "${spec.name}": ${previous} and ${spec.owner}.`,
        );
      }
      owners.set(spec.name, spec.owner);
    }
    return new GraphQLObjectType({
      name,
      fields: () =>
        Object.fromEntries(specs.map((s) => [s.name, this.#field(s, `${name}.${s.name}`)])),
    });
  }

  #field(spec: FieldSpec, where: string): GraphQLFieldConfig<any, any> {
    return {
      type: this.#outputType(spec.type, spec.nullable, where),
      args: this.#args(spec.args, where),
      description: spec.description,
      deprecationReason: spec.deprecationReason,
      resolve: spec.resolve,
      subscribe: spec.subscribe,
      extensions: spec.complexity === undefined ? undefined : { complexity: spec.complexity },
    };
  }

  /** Calls a type thunk, turning undefined (circular import) and TDZ errors into clear messages. */
  #evaluate(thunk: () => TypeThunkResult, where: string): unknown {
    const hint = () => {
      const name = guessName(thunk);
      return name ? `is ${name} imported?` : 'check for a circular import';
    };
    let value: unknown;
    try {
      value = thunk();
    } catch (error) {
      throw new SchemaBuildError(
        `${where}: type thunk threw (${(error as Error).message}) — ${hint()}`,
      );
    }
    const single = Array.isArray(value) ? value[0] : value;
    if (single === undefined || single === null) {
      throw new SchemaBuildError(`${where}: type thunk returned ${String(single)} — ${hint()}`);
    }
    if (Array.isArray(value) && value.length !== 1) {
      throw new SchemaBuildError(`${where}: a list type must be written as [Type].`);
    }
    return value;
  }

  #wrap<T extends GraphQLOutputType | GraphQLInputType>(
    value: unknown,
    nullable: Nullable | undefined,
    where: string,
    base: (ref: unknown) => T,
  ): T {
    if (Array.isArray(value)) {
      const item = base(value[0]);
      const itemNullable = nullable === 'items' || nullable === 'both';
      const listNullable = nullable === true || nullable === 'list' || nullable === 'both';
      const list = new GraphQLList(itemNullable ? item : new GraphQLNonNull(item));
      return (listNullable ? list : new GraphQLNonNull(list)) as unknown as T;
    }
    if (nullable === 'items' || nullable === 'list' || nullable === 'both') {
      throw new SchemaBuildError(`${where}: nullable: '${nullable}' applies to list types only.`);
    }
    const type = base(value);
    return (nullable === true ? type : new GraphQLNonNull(type)) as unknown as T;
  }

  #outputType(
    thunk: () => TypeThunkResult,
    nullable: Nullable | undefined,
    where: string,
  ): GraphQLOutputType {
    const value = this.#evaluate(thunk, where);
    return this.#wrap(value, nullable, where, (ref) => this.#outputBase(ref, where));
  }

  #inputType(
    thunk: () => TypeThunkResult,
    nullable: Nullable | undefined,
    where: string,
  ): GraphQLInputType {
    const value = this.#evaluate(thunk, where);
    return this.#wrap(value, nullable, where, (ref) => this.#inputBase(ref, where));
  }

  #outputBase(ref: unknown, where: string): GraphQLOutputType {
    const global = GLOBAL_SCALARS.get(ref);
    if (global) return global;
    if (isHandle(ref)) {
      if (ref.__kind === 'union') return this.#union(ref as UnionHandle<unknown>, where);
      const type = (ref as { graphql: GraphQLNamedType }).graphql;
      this.#claim(type.name, type, `${ref.__kind} ${type.name}`);
      return type as GraphQLOutputType;
    }
    if (typeof ref === 'function') {
      const def = getOwnMetadata(ref, TYPE_DEF);
      if (def?.kind === 'object' || def?.kind === 'interface')
        return this.#output(ref as Class, def);
      if (def?.kind === 'input') {
        throw new SchemaBuildError(
          `${where}: ${typeName(ref)} is an @InputType() and cannot be used as an output type.`,
        );
      }
      if (def?.kind === 'args') {
        throw new SchemaBuildError(
          `${where}: ${typeName(ref)} is an @ArgsType() and cannot be used as a field type.`,
        );
      }
      throw new SchemaBuildError(
        `${where}: ${typeName(ref)} is not decorated with @ObjectType() or @InterfaceType().`,
      );
    }
    throw new SchemaBuildError(`${where}: unsupported type reference ${String(ref)}.`);
  }

  #inputBase(ref: unknown, where: string): GraphQLInputType {
    const global = GLOBAL_SCALARS.get(ref);
    if (global) return global;
    if (isHandle(ref)) {
      if (ref.__kind === 'union') {
        throw new SchemaBuildError(`${where}: union ${ref.name} cannot be used as an input type.`);
      }
      const type = (ref as { graphql: GraphQLNamedType }).graphql;
      this.#claim(type.name, type, `${ref.__kind} ${type.name}`);
      return type as GraphQLInputType;
    }
    if (typeof ref === 'function') {
      const def = getOwnMetadata(ref, TYPE_DEF);
      if (def?.kind === 'input') return this.#input(ref as Class, def);
      if (def?.kind === 'args') {
        throw new SchemaBuildError(
          `${where}: @ArgsType() ${typeName(ref)} cannot be used as an argument type; ` +
            `pass it as \`args: ${typeName(ref)}\` (it cannot be combined with inline arguments).`,
        );
      }
      throw new SchemaBuildError(
        `${where}: ${typeName(ref)} is not an @InputType() and cannot be used as an input type.`,
      );
    }
    throw new SchemaBuildError(`${where}: unsupported type reference ${String(ref)}.`);
  }

  #namedType(cls: Class, where: string): GraphQLNamedType {
    const def = getOwnMetadata(cls, TYPE_DEF);
    if (def?.kind === 'input') return this.#input(cls, def);
    return this.#outputBase(cls, where) as GraphQLNamedType;
  }

  #output(cls: Class, def: TypeDefinition): GraphQLObjectType | GraphQLInterfaceType {
    const cached = this.#outputs.get(cls);
    if (cached) return cached;
    this.#claim(def.name, cls, cls.name);
    const interfaces = () =>
      (def.implements?.() ?? []).map((iface, i) => {
        const type = this.#outputBase(iface, `${def.name} implements[${i}]`);
        if (!(type instanceof GraphQLInterfaceType)) {
          throw new SchemaBuildError(
            `${def.name}: implements ${typeName(iface)}, which is not an @InterfaceType().`,
          );
        }
        return type;
      });
    const fields = () => this.#outputFields(cls, def);
    let type: GraphQLObjectType | GraphQLInterfaceType;
    if (def.kind === 'interface') {
      // Computed on first use, at execution time, when every object class is known.
      let implementations: Class[] | undefined;
      type = new GraphQLInterfaceType({
        name: def.name,
        description: def.description,
        interfaces,
        fields,
        resolveType: (value, _ctx, info) => {
          implementations ??= this.#implementationsOf(cls);
          return this.#resolveName(def.resolveType?.(value, info), value, implementations);
        },
      });
    } else {
      this.#objectClasses.set(cls, def);
      type = new GraphQLObjectType({
        name: def.name,
        description: def.description,
        interfaces,
        fields,
      });
    }
    this.#outputs.set(cls, type);
    return type;
  }

  #outputFields(cls: Class, def: TypeDefinition): Record<string, GraphQLFieldConfig<any, any>> {
    const out: Record<string, GraphQLFieldConfig<any, any>> = {};
    for (const field of collectFields(cls)) {
      const where = `${def.name}.${field.key}`;
      out[field.key] = {
        type: this.#outputType(field.type, field.options.nullable, where),
        description: field.options.description,
        deprecationReason: field.options.deprecationReason,
        extensions:
          field.options.complexity === undefined
            ? undefined
            : { complexity: field.options.complexity },
      };
    }
    for (const spec of this.input.typeFields.get(cls) ?? []) {
      out[spec.name] = this.#field(spec, `${def.name}.${spec.name}`);
    }
    // Interfaces are never wrapped: graphql-js resolves fields on the concrete object type.
    // Unguarded types keep graphql-js's default resolver, so they pay nothing per field.
    const { fieldGuards, wrapField } = this.input;
    if (def.kind === 'object' && wrapField && fieldGuards?.(cls)) {
      for (const config of Object.values(out)) {
        config.resolve = wrapField(cls, config.resolve ?? defaultFieldResolver);
      }
    }
    return out;
  }

  #input(cls: Class, def: TypeDefinition): GraphQLInputObjectType {
    const cached = this.#inputs.get(cls);
    if (cached) return cached;
    this.#claim(def.name, cls, cls.name);
    const type = new GraphQLInputObjectType({
      name: def.name,
      description: def.description,
      fields: () =>
        Object.fromEntries(
          collectFields(cls).map((field) => [
            field.key,
            {
              type: this.#inputType(field.type, field.options.nullable, `${def.name}.${field.key}`),
              description: field.options.description,
              deprecationReason: field.options.deprecationReason,
              defaultValue: field.options.defaultValue,
            },
          ]),
        ),
    });
    this.#inputs.set(cls, type);
    return type;
  }

  #args(
    args: ArgMap | Class | undefined,
    where: string,
  ): GraphQLFieldConfigArgumentMap | undefined {
    if (args === undefined) return undefined;
    const out: GraphQLFieldConfigArgumentMap = {};
    if (typeof args === 'function') {
      const def = getOwnMetadata(args, TYPE_DEF);
      if (def?.kind !== 'args') {
        throw new SchemaBuildError(
          `${where}: args class ${typeName(args)} is not decorated with @ArgsType().`,
        );
      }
      for (const field of collectFields(args)) {
        out[field.key] = {
          type: this.#inputType(field.type, field.options.nullable, `${where}(${field.key})`),
          description: field.options.description,
          deprecationReason: field.options.deprecationReason,
          defaultValue: field.options.defaultValue,
        };
      }
      return out;
    }
    for (const [name, spec] of Object.entries(args)) {
      const full = isArgObject(spec) ? spec : { type: () => spec as TypeThunkResult };
      const arg: GraphQLArgumentConfig = {
        type: this.#inputType(full.type, full.nullable, `${where}(${name})`),
        description: full.description,
        deprecationReason: full.deprecationReason,
        defaultValue: full.defaultValue,
      };
      out[name] = arg;
    }
    return out;
  }

  #union(handle: UnionHandle<unknown>, where: string): GraphQLUnionType {
    const cached = this.#unions.get(handle);
    if (cached) return cached;
    this.#claim(handle.name, handle, `union ${handle.name}`);
    // handle.types() runs once (the first successful call), not once per resolved value.
    let memo: readonly Class[] | undefined;
    const members = () => {
      if (memo) return memo;
      const classes = handle.types();
      if (classes.some((c) => c === undefined)) {
        throw new SchemaBuildError(
          `${where}: union ${handle.name} types() returned undefined — check for a circular import.`,
        );
      }
      memo = classes;
      return classes;
    };
    const type = new GraphQLUnionType({
      name: handle.name,
      description: handle.description,
      types: () =>
        members().map((cls, i) => {
          const member = this.#outputBase(cls, `union ${handle.name}[${i}]`);
          if (!(member instanceof GraphQLObjectType)) {
            throw new SchemaBuildError(
              `union ${handle.name}: ${typeName(cls)} is not an @ObjectType().`,
            );
          }
          return member;
        }),
      resolveType: (value, _ctx, info: GraphQLResolveInfo) =>
        this.#resolveName(handle.resolveType?.(value, info), value, members()),
    });
    this.#unions.set(handle, type);
    return type;
  }

  #implementationsOf(iface: Class): Class[] {
    return [...this.#objectClasses]
      .filter(([, d]) => d.implements?.().includes(iface))
      .map(([c]) => c);
  }

  /** Explicit resolveType result, else the most derived matching class, else `__typename`. */
  #resolveName(
    explicit: Class | string | undefined,
    value: unknown,
    candidates: readonly Class[],
  ): string | undefined {
    if (typeof explicit === 'string') return explicit;
    if (typeof explicit === 'function') return getOwnMetadata(explicit, TYPE_DEF)?.name;
    const matches = candidates.filter((c) => value instanceof c);
    matches.sort((a, b) => (b.prototype instanceof a ? 1 : a.prototype instanceof b ? -1 : 0));
    const match = matches[0];
    if (match) return getOwnMetadata(match, TYPE_DEF)?.name;
    const typename = (value as { __typename?: unknown } | null)?.__typename;
    return typeof typename === 'string' ? typename : undefined;
  }
}
