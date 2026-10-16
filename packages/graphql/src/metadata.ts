import { MetadataKey } from '@hpmws/core';
import type { GuardRef } from '@hpmws/http';
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
  meta?: Readonly<Record<PropertyKey, unknown>>;
}

export interface SubscriptionMethodOptions extends ResolverMethodOptions {
  topic: string | ((ctx: any) => string | readonly string[]);
  filter?: (event: { payload: any; args: any; ctx: any }) => boolean | Promise<boolean>;
  resolve?: (payload: any) => unknown;
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

export const TYPE_DEF = new MetadataKey<TypeDefinition>('hpmws:graphql:type');
export const FIELDS = new MetadataKey<FieldDefinition[]>('hpmws:graphql:fields');
export const RESOLVER = new MetadataKey<ResolverDefinition>('hpmws:graphql:resolver');
export const RESOLVER_METHODS = new MetadataKey<ResolverMethodDefinition[]>(
  'hpmws:graphql:resolver-methods',
);
