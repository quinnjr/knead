import { appendMetadata, setMetadata } from '@knead-js/core';
import type { GraphQLResolveInfo } from 'graphql';
import { FIELDS, type FieldOptions, TYPE_DEF, type TypeKind } from './metadata.js';
import type { Class, OutType, TypeThunkResult } from './type-refs.js';

export interface ObjectTypeOptions {
  name?: string;
  description?: string;
  implements?: () => readonly Class[];
}

export interface InputTypeOptions {
  name?: string;
  description?: string;
}

export interface InterfaceTypeOptions {
  name?: string;
  description?: string;
  implements?: () => readonly Class[];
  /** Defaults to an `instanceof` check over the implementing classes, then `value.__typename`. */
  resolveType?: (value: any, info: GraphQLResolveInfo) => Class | string | undefined;
}

function typeDecorator(
  kind: TypeKind,
  label: string,
  options: ObjectTypeOptions & InterfaceTypeOptions,
) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    const name = options.name ?? context.name;
    if (!name) throw new TypeError(`@${label}() needs a name for an anonymous class.`);
    setMetadata(context.metadata, TYPE_DEF, {
      kind,
      name,
      description: options.description,
      implements: options.implements,
      resolveType: options.resolveType,
    });
  };
}

export function ObjectType(options: ObjectTypeOptions = {}) {
  return typeDecorator('object', 'ObjectType', options);
}

export function InputType(options: InputTypeOptions = {}) {
  return typeDecorator('input', 'InputType', options);
}

export function InterfaceType(options: InterfaceTypeOptions = {}) {
  return typeDecorator('interface', 'InterfaceType', options);
}

/** A reusable argument set: its fields become the arguments of a resolver using `args: Cls`. */
export function ArgsType() {
  return typeDecorator('args', 'ArgsType', {});
}

/**
 * True when the field's TS type `V` is exactly what the GraphQL type produces (readonly or
 * mutable arrays both accepted).
 */
type Accept<V, R, Nl> = [V] extends [OutType<R, Nl, true>]
  ? [OutType<R, Nl, false>] extends [V]
    ? true
    : false
  : false;

/** True unless `defaultValue` is given and is not a value of the GraphQL type. */
type DefaultOk<R, O> = O extends { defaultValue: infer D }
  ? [D] extends [OutType<R, O extends { nullable: infer Nl } ? Nl : false, true>]
    ? true
    : false
  : true;

export type FieldDecorator<R, O extends FieldOptions> = <This, V>(
  value: undefined,
  context: ClassFieldDecoratorContext<This, V> &
    (DefaultOk<R, O> extends true
      ? unknown
      : {
          readonly 'defaultValue does not match the GraphQL field type': OutType<R, O['nullable']>;
        }) &
    (Accept<V, R, O['nullable']> extends true
      ? unknown
      : {
          readonly 'GraphQL field type does not match the TypeScript type': OutType<
            R,
            O['nullable']
          >;
        }),
) => void;

/**
 * Declares a GraphQL field. Compile error when the TS field type differs from the GraphQL type:
 * non-null fields must not include null/undefined; `nullable` fields must include both.
 */
export function Field<const R extends TypeThunkResult, const O extends FieldOptions = {}>(
  type: () => R,
  options?: O,
): FieldDecorator<R, O> {
  const decorator = (_value: undefined, context: ClassFieldDecoratorContext): void => {
    if (context.static || context.private || typeof context.name !== 'string') {
      throw new TypeError(
        `@Field() cannot decorate static, private or symbol-named field ${String(context.name)}.`,
      );
    }
    appendMetadata(context.metadata, FIELDS, {
      key: context.name,
      type,
      options: (options ?? {}) as FieldOptions,
    });
  };
  return decorator as FieldDecorator<R, O>;
}
