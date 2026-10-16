import { appendMetadata, INJECTABLE, setMetadata } from '@knead/core';
import { createRouteDecorator, type GuardRef } from '@knead/http';
import type {
  ResolverCtx,
  ResolverCtxKey,
  SubscriptionCtx,
  SubscriptionEventKey,
} from './context.js';
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

export interface SubscriptionOptions<A extends ArgMap | Class = {}, N extends Nullable = false>
  extends Omit<SubscriptionMethodOptions, 'guards' | 'args' | 'topic' | 'filter' | 'nullable'> {
  args?: A;
  nullable?: N;
  guards?: readonly GuardRef<ResolverCtx<any, any>>[];
  topic: string | ((ctx: SubscriptionCtx<ArgsTs<A>, undefined>) => string | readonly string[]);
  filter?: (event: {
    payload: any;
    args: ArgsTs<A>;
    ctx: SubscriptionCtx<ArgsTs<A>, any>;
  }) => boolean | Promise<boolean>;
}

/** Inline argument names whose `defaultValue` is not a value of the argument's type. */
export type BadArgDefaults<O> = O extends { args: infer A }
  ? A extends abstract new (
      ...args: any[]
    ) => any
    ? never
    : {
        [K in keyof A]: A[K] extends { type: () => infer R; defaultValue: infer D }
          ? [D] extends [OutType<R, A[K] extends { nullable: infer Nl } ? Nl : false, true>]
            ? never
            : K
          : never;
      }[keyof A]
  : never;

type ArgDefaultsCheck<O> = [BadArgDefaults<O>] extends [never]
  ? unknown
  : { readonly 'inline argument defaultValue does not match its type': BadArgDefaults<O> };

/**
 * A @ResolveField method's first parameter must be a ResolverCtx itself (branded, not a
 * SubscriptionCtx, structural look-alike or Pick/Omit of one), so the @Resolver parent check
 * sees it. Methods without parameters are fine.
 */
type FieldCtxCheck<F> = F extends (...args: infer P) => any
  ? P extends []
    ? unknown
    : P[0] extends infer C
      ? ResolverCtxKey extends keyof C
        ? SubscriptionEventKey extends keyof C
          ? { readonly '@ResolveField takes a ResolverCtx, not a SubscriptionCtx': never }
          : unknown
        : {
            readonly '@ResolveField takes a ResolverCtx<Args, Parent> as its first parameter': never;
          }
      : unknown
  : unknown;

export type ResolveFieldDecorator<R, O extends ResolverOptions> = <
  This,
  F extends (
    this: This,
    ctx: ResolverCtx<ArgsOf<O>, any>,
  ) => MaybePromise<OutType<R, O['nullable']>>,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F> & ArgDefaultsCheck<O> & FieldCtxCheck<F>,
) => void;

export type ResolverMethodDecorator<R, O extends ResolverOptions> = <
  This,
  F extends (
    this: This,
    ctx: ResolverCtx<ArgsOf<O>, any>,
  ) => MaybePromise<OutType<R, O['nullable']>>,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F> & ArgDefaultsCheck<O>,
) => void;

export type SubscriptionMethodDecorator<R, O extends { nullable?: Nullable }> = <
  This,
  F extends (
    this: This,
    ctx: SubscriptionCtx<ArgsOf<O>, any>,
    // biome-ignore lint/suspicious/noConfusingVoidType: an empty method body returns void
  ) => MaybePromise<OutType<R, O['nullable']> | undefined | void>,
>(
  method: F,
  context: ClassMethodDecoratorContext<This, F> & ArgDefaultsCheck<O>,
) => void;

/**
 * Names of methods whose ResolverCtx parent is not satisfied by the resolver type T. Methods
 * without a parent (`undefined`, the ResolverCtx default), subscription methods
 * (SubscriptionCtx) and methods whose first parameter is not a ResolverCtx are not checked.
 */
export type ParentMismatches<I, T> = {
  [K in keyof I]: I[K] extends (ctx: infer C, ...rest: any[]) => any
    ? ResolverCtxKey extends keyof C
      ? SubscriptionEventKey extends keyof C
        ? never
        : C extends { parent: infer P }
          ? [P] extends [undefined]
            ? never
            : [T] extends [P]
              ? never
              : K
          : never
      : never
    : never;
}[keyof I];

export type ResolverDecorator<T> = <C extends abstract new (...args: any[]) => any>(
  target: C,
  context: ClassDecoratorContext<C> &
    ([T] extends [undefined]
      ? unknown
      : [ParentMismatches<InstanceType<C>, T>] extends [never]
        ? unknown
        : {
            readonly '@ResolveField parent type does not match the @Resolver type': ParentMismatches<
              InstanceType<C>,
              T
            >;
          }),
) => void;

/** Marks a provider as a resolver (implies a singleton @Injectable). `type` enables @ResolveField. */
export function Resolver<T = undefined>(type?: () => Class<T>): ResolverDecorator<T> {
  const decorator = (_target: Function, context: ClassDecoratorContext): void => {
    setMetadata(context.metadata, INJECTABLE, { scope: 'singleton' });
    setMetadata(context.metadata, RESOLVER, { type });
  };
  return decorator as ResolverDecorator<T>;
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
): ResolveFieldDecorator<R, O> {
  return method('field', 'ResolveField', type, options ?? {}) as ResolveFieldDecorator<R, O>;
}

/**
 * A subscription field fed by PUBSUB `topic`. Each event (after `resolve`) is `ctx.parent`; the
 * method may return a transformed value or nothing (the event is then the result).
 */
export function Subscription<
  const R extends TypeThunkResult,
  const A extends ArgMap | Class = {},
  const N extends Nullable = false,
>(
  type: () => R,
  options: SubscriptionOptions<A, N>,
): SubscriptionMethodDecorator<R, { args: A; nullable: N }> {
  return method('subscription', 'Subscription', type, options) as SubscriptionMethodDecorator<
    R,
    { args: A; nullable: N }
  >;
}

/** The `ctx.meta` key set by `@Public()`. */
export const IS_PUBLIC: unique symbol = Symbol('knead:graphql:public');

const publicMeta = createRouteDecorator<true>(IS_PUBLIC);

/**
 * Marks a resolver class or root field as public: module-level `guards` do not run for it, and
 * `defaultDeny` lets it through. Its own class and method guards still run.
 */
export const Public = () => publicMeta(true);
