import { MetadataKey } from '@knead/core';
import type { GuardRef } from '@knead/http';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { GraphQLResolveInfo } from 'graphql';
import type { Class, Nullable, TypeThunkResult } from './type-refs.js';

export type TypeKind = 'object' | 'input' | 'interface' | 'args';

export interface TypeDefinition {
  kind: TypeKind;
  name: string;
  description?: string | undefined;
  implements?: (() => readonly Class[]) | undefined;
  resolveType?: ((value: any, info: GraphQLResolveInfo) => Class | string | undefined) | undefined;
}

export interface FieldOptions {
  nullable?: Nullable;
  description?: string;
  deprecationReason?: string;
  /** Input fields and arguments only. */
  defaultValue?: unknown;
  /** Cost of this field for `maxComplexity` (default 1). */
  complexity?: number;
}

export interface FieldDefinition {
  key: string;
  type: () => TypeThunkResult;
  options: FieldOptions;
}

/** An inline argument: a type reference, `[type]`, or a full spec. */
export type ArgSpec =
  | TypeThunkResult
  | {
      type: () => TypeThunkResult;
      nullable?: Nullable;
      description?: string;
      defaultValue?: unknown;
      deprecationReason?: string;
    };

export type ArgMap = Readonly<Record<string, ArgSpec>>;

export type ResolverKind = 'query' | 'mutation' | 'subscription' | 'field';

export interface ResolverMethodOptions {
  name?: string;
  nullable?: Nullable;
  /** An inline argument map, or an `@ArgsType()` class. Not both. */
  args?: ArgMap | Class;
  /** Standard Schemas run per argument after GraphQL coercion; failures are BAD_USER_INPUT. */
  validate?: Readonly<Record<string, StandardSchemaV1>>;
  description?: string;
  deprecationReason?: string;
  complexity?: number;
  /** Guards receiving the ResolverCtx; run after class-level @UseGuards guards. */
  guards?: readonly GuardRef<any>[];
  /**
   * Guards that run after `validate`, so they see the validated (and transformed) `ctx.args`.
   * `guards` run before validation and see the coerced but unvalidated arguments. Anything but
   * `true` is FORBIDDEN.
   */
  authorize?: readonly GuardRef<any>[];
  meta?: Readonly<Record<PropertyKey, unknown>>;
}

export interface SubscriptionMethodOptions extends ResolverMethodOptions {
  topic: string | ((ctx: any) => string | readonly string[]);
  filter?: (event: { payload: any; args: any; ctx: any }) => boolean | Promise<boolean>;
  resolve?: (payload: any) => unknown;
  /**
   * Re-run the root guards (module, class and method guards), then `authorize`, before every event. An event whose
   * guards deny is delivered as a FORBIDDEN error (or the guard's own error) and ends the
   * subscription. Default false: guards run once, when the operation subscribes.
   */
  recheckGuards?: boolean;
}

export interface ResolverMethodDefinition {
  kind: ResolverKind;
  method: string;
  type: () => TypeThunkResult;
  options: ResolverMethodOptions | SubscriptionMethodOptions;
}

export interface ResolverDefinition {
  type: (() => Class) | undefined;
}

export const TYPE_DEF = new MetadataKey<TypeDefinition>('knead:graphql:type');
export const FIELDS = new MetadataKey<FieldDefinition[]>('knead:graphql:fields');
export const RESOLVER = new MetadataKey<ResolverDefinition>('knead:graphql:resolver');
export const RESOLVER_METHODS = new MetadataKey<ResolverMethodDefinition[]>(
  'knead:graphql:resolver-methods',
);
