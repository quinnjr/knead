import { appendMetadata, INJECTABLE, setMetadata } from '@hpmws/core';
import type { GuardRef } from '@hpmws/http';
import type { ResolverCtx } from './context.js';
import {
  type ArgMap,
  RESOLVER,
  RESOLVER_METHODS,
  type ResolverKind,
  type ResolverMethodOptions,
  type SubscriptionMethodOptions,
} from './metadata.js';
import type { Class, Nullable, OutType, TypeThunkResult } from './type-refs.js';

type ArgTs<S> = S extends { type: () => infer R }
  ? OutType<R, S extends { nullable: infer Nl } ? Nl : false>
  : OutType<S, false>;

/** The TS type of declared arguments: an @ArgsType class's instance, or an inline map. */
export type ArgsTs<A> = A extends abstract new (
  ...args: any[]
) => infer I
  ? I
  : { -readonly [K in keyof A]: ArgTs<A[K]> };

export type ArgsOf<O> = O extends { args: infer A } ? ArgsTs<A> : {};

type MaybePromise<T> = T | Promise<T>;

/** Public option types: guards are typed against ResolverCtx. */
export interface ResolverOptions extends Omit<ResolverMethodOptions, 'guards' | 'args'> {
  args?: ArgMap | Class;
  guards?: readonly GuardRef<ResolverCtx<any, any>>[];
}

export interface SubscriptionOptions<A = any>
  extends Omit<SubscriptionMethodOptions, 'guards' | 'args' | 'topic' | 'filter'> {
  args?: ArgMap | Class;
  guards?: readonly GuardRef<ResolverCtx<any, any>>[];
  topic: string | ((ctx: ResolverCtx<A, undefined>) => string | readonly string[]);
  filter?: (event: {
    payload: any;
    args: A;
    ctx: ResolverCtx<A, any>;
  }) => boolean | Promise<boolean>;
}

export type ResolverMethodDecorator<R, O extends ResolverOptions> = <
  This,
  F extends (
    this: This,
    ctx: ResolverCtx<ArgsOf<O>, any>,
  ) => MaybePromise<OutType<R, O['nullable']>>,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F>,
) => void;

export type SubscriptionMethodDecorator<R, O extends { nullable?: Nullable }> = <
  This,
  F extends (
    this: This,
    ctx: ResolverCtx<ArgsOf<O>, any>,
    // biome-ignore lint/suspicious/noConfusingVoidType: an empty method body returns void
  ) => MaybePromise<OutType<R, O['nullable']> | undefined | void>,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F>,
) => void;

/** Marks a provider as a resolver (implies a singleton @Injectable). `type` enables @ResolveField. */
export function Resolver(type?: () => Class) {
  return (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, INJECTABLE, { scope: 'singleton' });
    setMetadata(context.metadata, RESOLVER, { type });
  };
}

function method(kind: ResolverKind, label: string, type: () => TypeThunkResult, options: object) {
  return (_method: unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private || typeof context.name !== 'string') {
      throw new TypeError(
        `@${label}() cannot decorate static, private or symbol-named method ${String(context.name)}.`,
      );
    }
    appendMetadata(context.metadata, RESOLVER_METHODS, {
      kind,
      method: context.name,
      type,
      options: options as ResolverMethodOptions,
    });
  };
}

export function Query<const R extends TypeThunkResult, const O extends ResolverOptions = {}>(
  type: () => R,
  options?: O,
): ResolverMethodDecorator<R, O> {
  return method('query', 'Query', type, options ?? {}) as ResolverMethodDecorator<R, O>;
}

export function Mutation<const R extends TypeThunkResult, const O extends ResolverOptions = {}>(
  type: () => R,
  options?: O,
): ResolverMethodDecorator<R, O> {
  return method('mutation', 'Mutation', type, options ?? {}) as ResolverMethodDecorator<R, O>;
}

/** A field of the @Resolver(() => T) type, resolved by this method (`ctx.parent` is the T). */
export function ResolveField<const R extends TypeThunkResult, const O extends ResolverOptions = {}>(
  type: () => R,
  options?: O,
): ResolverMethodDecorator<R, O> {
  return method('field', 'ResolveField', type, options ?? {}) as ResolverMethodDecorator<R, O>;
}

/**
 * A subscription field fed by PUBSUB `topic`. Each event (after `resolve`) is `ctx.parent`; the
 * method may return a transformed value or nothing (the event is then the result).
 */
export function Subscription<const R extends TypeThunkResult, const O extends SubscriptionOptions>(
  type: () => R,
  options: O,
): SubscriptionMethodDecorator<R, O> {
  return method('subscription', 'Subscription', type, options) as SubscriptionMethodDecorator<R, O>;
}
