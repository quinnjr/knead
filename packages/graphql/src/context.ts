import type { ModuleInjector, Type } from '@hpmws/core';
import type { Ctx } from '@hpmws/http';
import DataLoader from 'dataloader';
import type { GraphQLResolveInfo } from 'graphql';

/**
 * Augment to type the object returned by `GraphQLModule.forRoot({ context })`:
 * `declare module '@hpmws/graphql' { interface GraphQLContext { user?: User } }`
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point
export interface GraphQLContext {}

/** A singleton batch loader; `ctx.loader(Cls)` gives one DataLoader per operation. */
export interface BatchLoader<K, V> {
  batch(keys: readonly K[]): Promise<readonly (V | Error)[]>;
  readonly options?: DataLoader.Options<K, V>;
}

export interface ResolverCtx<A = {}, P = undefined> extends GraphQLContext {
  args: A;
  parent: P;
  info: GraphQLResolveInfo;
  /** The request Ctx; for subscriptions, the WebSocket upgrade request's Ctx. */
  http: Ctx;
  /** Per-operation scratch space shared by every resolver of the operation. */
  state: Record<PropertyKey, unknown>;
  /** Resolver metadata: `meta` option and createRouteDecorator() values. */
  meta: Readonly<Record<PropertyKey, unknown>>;
  loader<K, V>(cls: Type<BatchLoader<K, V>>): DataLoader<K, V>;
}

/** @internal One per GraphQL operation; graphql-js passes it to every resolver as contextValue. */
export class OperationContext {
  readonly state: Record<PropertyKey, unknown> = {};
  readonly #loaders = new Map<Function, DataLoader<unknown, unknown>>();

  constructor(
    readonly http: Ctx,
    readonly user: Readonly<Record<PropertyKey, unknown>>,
  ) {}

  loader<K, V>(cls: Type<BatchLoader<K, V>>, injector: ModuleInjector): DataLoader<K, V> {
    let loader = this.#loaders.get(cls);
    if (!loader) {
      const batcher = injector.resolveOrConstruct(cls);
      loader = new DataLoader<K, V>((keys) => batcher.batch(keys), batcher.options) as DataLoader<
        unknown,
        unknown
      >;
      this.#loaders.set(cls, loader);
    }
    return loader as DataLoader<K, V>;
  }
}

/** @internal Builds the ctx handed to one resolver call. */
export function createResolverCtx(
  op: OperationContext,
  injector: ModuleInjector,
  meta: Readonly<Record<PropertyKey, unknown>>,
  args: unknown,
  parent: unknown,
  info: GraphQLResolveInfo,
): ResolverCtx<any, any> {
  return {
    ...op.user,
    args,
    parent,
    info,
    http: op.http,
    state: op.state,
    meta,
    loader: (cls) => op.loader(cls, injector),
  };
}
