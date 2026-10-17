import type { ModuleInjector, Type } from '@knead-js/core';
import type { Ctx } from '@knead-js/http';
import DataLoader from 'dataloader';
import type { GraphQLResolveInfo } from 'graphql';

/**
 * Augment to type the object returned by `GraphQLModule.forRoot({ context })`:
 * `declare module '@knead-js/graphql' { interface GraphQLContext { user?: User } }`
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point
export interface GraphQLContext {}

/** A singleton batch loader; `ctx.loader(Cls)` gives one DataLoader per operation. */
export interface BatchLoader<K, V> {
  batch(keys: readonly K[]): Promise<readonly (V | Error)[]>;
  readonly options?: DataLoader.Options<K, V>;
}

/** Phantom key identifying a ResolverCtx (so the @Resolver parent check ignores other methods). */
declare const RESOLVER_CTX: unique symbol;
export type ResolverCtxKey = typeof RESOLVER_CTX;

export interface ResolverCtx<A = {}, P = undefined> extends GraphQLContext {
  readonly [RESOLVER_CTX]?: true;
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

export type OperationKind = 'query' | 'mutation' | 'subscription';

/** Phantom key marking a subscription method's ctx (its parent is the event payload). */
declare const SUBSCRIPTION_EVENT: unique symbol;
export type SubscriptionEventKey = typeof SUBSCRIPTION_EVENT;

/**
 * The ctx of a @Subscription method: `parent` is the event (after `resolve`). Use it instead of
 * ResolverCtx in typed resolvers, whose ResolverCtx parents must match the @Resolver type.
 */
export interface SubscriptionCtx<A = {}, P = unknown> extends ResolverCtx<A, P> {
  readonly [SUBSCRIPTION_EVENT]?: true;
}

/** @internal One per GraphQL operation; graphql-js passes it to every resolver as contextValue. */
export class OperationContext {
  readonly state: Record<PropertyKey, unknown> = {};
  /** DataLoaders per module injector, then per class: each module resolves its own batcher. */
  readonly #loaders = new Map<ModuleInjector, Map<Function, DataLoader<unknown, unknown>>>();
  /** `ctx.loader` per module injector, so a ctx does not allocate a closure per field. */
  readonly #loaderFns = new Map<ModuleInjector, ResolverCtx['loader']>();
  /** The operation to run (checked against `allowedOperations` before execution). */
  operationName: string | undefined;
  /** Set when the executed document's operation was not allowed on this transport. */
  rejectedOperation: OperationKind | undefined;

  constructor(
    readonly http: Ctx,
    /** The user context; subscriptions.refreshContext may replace it before a recheck. */
    public user: Readonly<Record<PropertyKey, unknown>>,
    readonly allowedOperations: readonly OperationKind[],
  ) {}

  /**
   * Starts a new subscription event: loaders and state are per event, so a long-lived
   * subscription neither serves stale cached values nor grows without bound.
   */
  resetForEvent(): void {
    this.#loaders.clear();
    for (const key of Reflect.ownKeys(this.state)) delete this.state[key];
  }

  /** @internal The `ctx.loader` function of resolvers in `injector`'s module. */
  loaderFor(injector: ModuleInjector): ResolverCtx['loader'] {
    let fn = this.#loaderFns.get(injector);
    if (!fn) {
      fn = (cls) => this.loader(cls, injector);
      this.#loaderFns.set(injector, fn);
    }
    return fn;
  }

  loader<K, V>(cls: Type<BatchLoader<K, V>>, injector: ModuleInjector): DataLoader<K, V> {
    let loaders = this.#loaders.get(injector);
    if (!loaders) {
      loaders = new Map();
      this.#loaders.set(injector, loaders);
    }
    let loader = loaders.get(cls);
    if (!loader) {
      const batcher = injector.resolveOrConstruct(cls);
      loader = new DataLoader<K, V>((keys) => batcher.batch(keys), batcher.options) as DataLoader<
        unknown,
        unknown
      >;
      loaders.set(cls, loader);
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
    loader: op.loaderFor(injector),
  };
}
